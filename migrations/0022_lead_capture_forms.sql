-- Formularios universais de captacao e prova imutavel de consentimento.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

create table public.lead_capture_forms (
  id uuid primary key default gen_random_uuid(),
  -- Identificador NAO secreto que vai no codigo de incorporacao. Sempre gerado
  -- pela API (base64url de 12 bytes = 16 caracteres); sem default no banco pra
  -- nunca depender de pgcrypto nem de alfabeto que nao seja seguro em URL.
  public_id text not null unique check (public_id ~ '^lf_[A-Za-z0-9_-]{16}$'),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  name text not null,
  allowed_origins text[] not null check (cardinality(allowed_origins) between 1 and 10),
  pipeline_stage text not null default 'lead' check (pipeline_stage in ('lead','conversa_iniciada','reuniao_marcada','proposta')),
  -- O link e executado no navegador do visitante: so https, mesmo se alguem
  -- gravar direto no banco (a API ja valida, isto e a segunda barreira).
  redirect_url text check (redirect_url is null or redirect_url ~ '^https://'),
  success_message text check (success_message is null or char_length(success_message) <= 300),
  consent_version integer not null default 1,
  active boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index lead_capture_forms_doctor_idx on public.lead_capture_forms (doctor_id);

-- Historico imutavel: cada edicao do texto cria uma versao nova; nunca update.
create table public.lead_capture_form_consent_versions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.lead_capture_forms(id) on delete cascade,
  version integer not null,
  consent_text text not null,
  created_by uuid references public.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  unique (form_id, version)
);

-- Prova de consentimento, append-only. on delete restrict de proposito: apagar
-- um formulario ou um medico NAO pode levar a prova junto sem uma decisao
-- explicita (a exclusao de um tenant precisa apagar estas linhas antes).
create table public.lead_capture_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.lead_capture_forms(id) on delete restrict,
  doctor_id uuid not null references public.doctors(id),
  organization_id uuid references public.organizations(id),
  lead_id uuid references public.leads(id) on delete set null,
  phone_hash text not null,
  consent_given boolean not null,
  consent_applied boolean not null,
  consent_block_reason text,
  consent_version integer not null,
  consent_text_snapshot text not null,
  consented_at timestamptz,
  page_origin text,
  page_url text,
  utm jsonb not null default '{}'::jsonb,
  ip_hash text,
  outcome text not null check (outcome in ('created','updated','unchanged','throttled')),
  criado_em timestamptz not null default now()
);
create index lead_capture_submissions_throttle_idx on public.lead_capture_submissions (form_id, phone_hash, criado_em);
create index lead_capture_submissions_lead_idx on public.lead_capture_submissions (lead_id);

alter table public.lead_capture_forms enable row level security;
alter table public.lead_capture_form_consent_versions enable row level security;
alter table public.lead_capture_submissions enable row level security;
revoke all on public.lead_capture_forms from anon, authenticated;
revoke all on public.lead_capture_form_consent_versions from anon, authenticated;
revoke all on public.lead_capture_submissions from anon, authenticated;
grant all on public.lead_capture_forms to service_role;
grant all on public.lead_capture_form_consent_versions to service_role;
grant all on public.lead_capture_submissions to service_role;

-- Captura atomica. O tenant (doctor_id/organization_id) vem SEMPRE da linha do
-- formulario; o cliente nunca escolhe. Um lock advisory por (medico, telefone)
-- serializa envios concorrentes do mesmo contato — leads nao tem indice unico
-- por telefone, entao sem o lock dois envios simultaneos criariam dois leads.
create or replace function public.lead_form_submit(
  p_public_id text, p_nome text, p_email text, p_telefone text,
  p_telefone_normalizado text, p_consent boolean, p_page_origin text,
  p_page_url text, p_utm jsonb, p_ip_hash text
)
returns table(lead_id uuid, outcome text, consent_applied boolean, redirect_url text, success_message text)
language plpgsql security definer set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_form public.lead_capture_forms%rowtype;
  v_consent_text text;
  v_lead public.leads%rowtype;
  v_lead_id uuid;
  v_outcome text := 'unchanged';
  v_applied boolean := false;
  v_block text;
  -- sha256 nativo (pg_catalog): pgcrypto nao resolve com search_path vazio.
  v_hash text;
  v_now timestamptz := now();
  v_changed boolean := false;
  v_row_count integer := 0;
  v_etapa text;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  p_consent := coalesce(p_consent, false);
  if p_telefone_normalizado is null or p_telefone_normalizado !~ '^55[0-9]{10,11}$' then
    raise exception 'invalid_phone';
  end if;
  v_hash := encode(sha256(convert_to(p_telefone_normalizado, 'UTF8')), 'hex');

  select * into v_form from public.lead_capture_forms f where f.public_id = p_public_id and f.active = true limit 1;
  if not found then raise exception 'form_not_found'; end if;
  select cv.consent_text into v_consent_text from public.lead_capture_form_consent_versions cv
    where cv.form_id = v_form.id and cv.version = v_form.consent_version limit 1;
  -- Sem o texto exibido nao ha prova: nunca aceitar o envio.
  if v_consent_text is null then raise exception 'consent_version_missing'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_form.doctor_id::text || ':' || p_telefone_normalizado, 0));

  -- Escopo estrito no medico do formulario: um lead nunca troca de tenant.
  -- Leads legados sem telefone_normalizado casam pelos digitos do telefone bruto
  -- (com ou sem o 55) — sem isso o formulario duplicaria contatos antigos.
  select * into v_lead from public.leads l
    where l.doctor_id = v_form.doctor_id
      and (l.telefone_normalizado = p_telefone_normalizado
        or (l.telefone_normalizado is null
            and regexp_replace(coalesce(l.telefone, ''), '[^0-9]', '', 'g') in (p_telefone_normalizado, substr(p_telefone_normalizado, 3))))
    order by (l.telefone_normalizado is not null) desc, l.criado_em asc nulls last
    limit 1;

  if (select count(*) from public.lead_capture_submissions s
        where s.form_id = v_form.id and s.phone_hash = v_hash and s.criado_em >= v_now - interval '10 minutes') > 3 then
    v_outcome := 'throttled';
    v_lead_id := v_lead.id;
  elsif v_lead.id is null then
    insert into public.leads (doctor_id, organization_id, nome, email, telefone, telefone_normalizado,
      origem, origem_lead, utm_source, utm_campaign, utm_criativo, journey_type, status_atual,
      whatsapp_authorization_status, whatsapp_authorization_at, whatsapp_authorization_source)
    values (v_form.doctor_id, v_form.organization_id, p_nome, p_email, p_telefone, p_telefone_normalizado,
      'formulario_captacao', left(v_form.name, 120), p_utm->>'utm_source', p_utm->>'utm_campaign',
      coalesce(p_utm->>'utm_content', p_utm->>'utm_criativo'), 'low_ticket', v_form.pipeline_stage,
      case when p_consent then 'autorizado' else 'pendente' end,
      case when p_consent then v_now end, case when p_consent then 'lead_form:' || p_public_id end)
    returning id into v_lead_id;
    v_outcome := 'created'; v_applied := p_consent;
  else
    v_lead_id := v_lead.id;
    -- Primeiro toque preservado: so preenche o que esta NULL.
    update public.leads l set
      email = coalesce(l.email, p_email),
      telefone_normalizado = coalesce(l.telefone_normalizado, p_telefone_normalizado),
      origem = coalesce(l.origem, 'formulario_captacao'),
      utm_source = coalesce(l.utm_source, p_utm->>'utm_source'),
      utm_campaign = coalesce(l.utm_campaign, p_utm->>'utm_campaign'),
      utm_criativo = coalesce(l.utm_criativo, coalesce(p_utm->>'utm_content', p_utm->>'utm_criativo'))
      where l.id = v_lead_id and (
        (l.email is null and p_email is not null) or l.telefone_normalizado is null or l.origem is null or
        (l.utm_source is null and p_utm->>'utm_source' is not null) or
        (l.utm_campaign is null and p_utm->>'utm_campaign' is not null) or
        (l.utm_criativo is null and coalesce(p_utm->>'utm_content', p_utm->>'utm_criativo') is not null));
    get diagnostics v_row_count = row_count;
    v_changed := v_row_count > 0;
    -- Consentimento: nunca reverte opt_out/recusado, nunca rebaixa autorizado.
    if p_consent then
      if v_lead.whatsapp_authorization_status = 'pendente' then
        update public.leads set whatsapp_authorization_status = 'autorizado', whatsapp_authorization_at = v_now,
          whatsapp_authorization_source = 'lead_form:' || p_public_id where id = v_lead_id;
        v_applied := true; v_changed := true;
      elsif v_lead.whatsapp_authorization_status = 'opt_out' then v_block := 'previous_opt_out';
      elsif v_lead.whatsapp_authorization_status = 'recusado' then v_block := 'previous_recusado';
      elsif v_lead.whatsapp_authorization_status = 'autorizado' then v_block := 'already_authorized';
      end if;
    end if;
    v_outcome := case when v_changed then 'updated' else 'unchanged' end;
  end if;

  -- Cartao do funil: mesmo criterio do ensurePipelineDeal (qualquer deal do
  -- lead conta), na etapa do formulario so para lead NOVO.
  if v_outcome <> 'throttled' and v_lead_id is not null
     and not exists (select 1 from public.deals d where d.lead_id = v_lead_id) then
    v_etapa := case
      when v_lead.id is null then v_form.pipeline_stage
      when v_lead.status_atual in ('lead','conversa_iniciada','reuniao_marcada','proposta','fechado','perdido') then v_lead.status_atual
      else 'lead' end;
    begin
      insert into public.deals (lead_id, etapa, sdr_responsavel_id)
      values (v_lead_id, v_etapa, v_lead.sdr_responsavel_id);
    exception when unique_violation then null; end;
  end if;

  insert into public.lead_capture_submissions(form_id, doctor_id, organization_id, lead_id, phone_hash,
    consent_given, consent_applied, consent_block_reason, consent_version, consent_text_snapshot, consented_at,
    page_origin, page_url, utm, ip_hash, outcome)
  values (v_form.id, v_form.doctor_id, v_form.organization_id, v_lead_id, v_hash,
    p_consent, v_applied, v_block, v_form.consent_version, v_consent_text, case when p_consent then v_now end,
    p_page_origin, left(p_page_url, 500), coalesce(p_utm, '{}'::jsonb), p_ip_hash, v_outcome);

  return query select v_lead_id, v_outcome, v_applied, v_form.redirect_url, v_form.success_message;
end;
$fn$;

do $grants$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='lead_form_submit' loop
   execute format('revoke execute on function %s from public',r.sig); execute format('revoke execute on function %s from anon, authenticated',r.sig); execute format('grant execute on function %s to service_role',r.sig);
 end loop;
end;$grants$;
