-- FASE 2 — campanhas por templates aprovados da Meta (aditiva, Postgres-only).
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto sem revisão.

-- Cache local dos templates aprovados/pendentes da WABA de cada médico.
-- Nunca é a fonte de verdade — é um SNAPSHOT sincronizado sob demanda via
-- GET /{waba_id}/message_templates (ver src/routes/integrations.js). Nada
-- aqui pode ser criado/editado pelo Prognexo: templates só existem se o
-- médico os aprovou no Business Manager da Meta.
create table public.whatsapp_templates (
  id                    uuid primary key default gen_random_uuid(),
  doctor_id             uuid not null references public.doctors(id) on delete cascade,
  organization_id       uuid references public.organizations(id),
  meta_template_id      text not null,
  nome                  text not null,
  idioma                text not null,
  categoria             text,
  status                text not null,
  parameter_format      text,
  -- Componentes crus da Meta (HEADER/BODY/FOOTER/BUTTONS), usados só pra
  -- decidir `supported`/`body_variable_count` no momento do sync — nunca
  -- expostos brutos na API (ver stripSecrets-like sanitização na rota).
  componentes           jsonb not null default '[]'::jsonb,
  body_text             text,
  body_variable_count   integer not null default 0,
  -- Suporte do MVP (ver src/lib/whatsappTemplates.js): BODY textual,
  -- parâmetros posicionais contíguos, sem variável em HEADER/botão, sem
  -- mídia obrigatória, sem parâmetro nomeado.
  supported             boolean not null default false,
  unsupported_reason    text,
  -- false = não visto na última sincronização completa (a Meta não retornou
  -- mais esse template) — nunca é deletado, só marcado inativo (auditoria).
  active                boolean not null default true,
  last_synced_at        timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (doctor_id, meta_template_id)
);
create index whatsapp_templates_doctor_idx on public.whatsapp_templates (doctor_id);
-- Índice do caminho quente do seletor de campanha (só isso é candidato).
create index whatsapp_templates_selectable_idx on public.whatsapp_templates (doctor_id)
  where active and supported and status = 'APPROVED';

-- Mesmo padrão do projeto: RLS ligada, SEM policy — só a service role do
-- backend acessa. Nenhum acesso de anon/authenticated.
alter table public.whatsapp_templates enable row level security;
revoke all on public.whatsapp_templates from public, anon, authenticated;

-- Campanha escolhe EXPLICITAMENTE o modo de envio — nunca um default
-- implícito que muda o comportamento de uma campanha já criada.
alter table public.campanhas
  add column modo_envio text not null default 'texto_livre',
  add constraint campanhas_modo_envio_check check (modo_envio in ('texto_livre', 'template')),
  add column whatsapp_template_id uuid references public.whatsapp_templates(id),
  -- { "1": {"source":"lead_nome"}, "2": {"source":"fixo","value":"..."} } —
  -- validado pela aplicação antes de gravar (nunca confiado cegamente no envio).
  add column template_variable_map jsonb,
  -- Congela os dados do template NO MOMENTO da criação da campanha (nome,
  -- idioma, categoria, body_text, contagem de variáveis) — auditoria e
  -- detecção de "o template mudou depois que a campanha foi criada". O envio
  -- SEMPRE revalida contra o cache atual antes de falar com a Meta; o
  -- snapshot nunca é usado para decidir se pode enviar, só para exibir/auditar.
  add column template_snapshot jsonb;

alter table public.campanha_envios
  add column message_id text,
  add column meta_status text,
  add column meta_status_at timestamptz,
  add column meta_error_code text,
  -- Trava atômica de UMA tentativa de envio: setada via UPDATE condicional
  -- (status='enviando' AND envio_iniciado_em IS NULL) imediatamente antes da
  -- chamada HTTP à Meta — nunca antes disso. Se uma nova execução do MESMO
  -- job (lease expirada após crash, retomada por outro worker) encontrar
  -- status='enviando' com este campo JÁ preenchido, sabe que uma tentativa
  -- anterior começou e nunca terminou: nunca reenvia, marca
  -- 'resultado_desconhecido'. Limpo de volta para NULL só quando o erro é uma
  -- rejeição confirmada da Meta que ainda vai tentar de novo (retry legítimo).
  add column envio_iniciado_em timestamptz;

-- message_id é o identificador que os webhooks de status usam pra localizar
-- o envio (sent/delivered/read/failed) — único quando presente, nunca
-- reaproveitado entre destinatários diferentes.
create unique index campanha_envios_message_id_key on public.campanha_envios (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- Sync atômico e seguro do cache de templates de UM médico.
--
-- Contrato (chamado só depois que o backend já paginou TODOS os templates da
-- Meta e montou o array completo — nunca chamado por página):
--   - upsert de todos os templates recebidos (por doctor_id+meta_template_id);
--   - active=true para todos os vistos nesta chamada;
--   - active=false para os que já existiam no cache e NÃO vieram nesta lista
--     (a Meta não os retornou mais — arquivados/removidos do lado deles);
--   - tudo numa única transação: qualquer erro no meio reverte o snapshot
--     inteiro, o cache anterior nunca fica parcialmente substituído.
--
-- Segurança: SECURITY DEFINER, search_path='', backend-only (auth.uid() nulo,
-- mesmo padrão de job_queue/usage_*). Nunca deleta linha nenhuma.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_templates_sync_replace(
  p_doctor_id uuid, p_organization_id uuid, p_templates jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_seen_ids text[];
  v_upserted int := 0;
  v_deactivated int := 0;
  v_item jsonb;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  if p_doctor_id is null then raise exception 'invalid_argument'; end if;
  if jsonb_typeof(coalesce(p_templates, '[]'::jsonb)) <> 'array' then raise exception 'invalid_argument'; end if;
  if not exists (select 1 from public.doctors where id = p_doctor_id) then raise exception 'not_found'; end if;

  select coalesce(array_agg(value ->> 'meta_template_id'), array[]::text[])
    into v_seen_ids
    from jsonb_array_elements(coalesce(p_templates, '[]'::jsonb));

  for v_item in select * from jsonb_array_elements(coalesce(p_templates, '[]'::jsonb))
  loop
    if nullif(btrim(coalesce(v_item ->> 'meta_template_id', '')), '') is null then
      raise exception 'invalid_argument';
    end if;

    insert into public.whatsapp_templates (
      doctor_id, organization_id, meta_template_id, nome, idioma, categoria, status,
      parameter_format, componentes, body_text, body_variable_count, supported,
      unsupported_reason, active, last_synced_at
    ) values (
      p_doctor_id, p_organization_id,
      v_item ->> 'meta_template_id', v_item ->> 'nome', v_item ->> 'idioma', v_item ->> 'categoria', v_item ->> 'status',
      v_item ->> 'parameter_format', coalesce(v_item -> 'componentes', '[]'::jsonb), v_item ->> 'body_text',
      coalesce((v_item ->> 'body_variable_count')::int, 0), coalesce((v_item ->> 'supported')::boolean, false),
      v_item ->> 'unsupported_reason', true, now()
    )
    on conflict (doctor_id, meta_template_id) do update set
      organization_id = excluded.organization_id, nome = excluded.nome, idioma = excluded.idioma,
      categoria = excluded.categoria, status = excluded.status, parameter_format = excluded.parameter_format,
      componentes = excluded.componentes, body_text = excluded.body_text,
      body_variable_count = excluded.body_variable_count, supported = excluded.supported,
      unsupported_reason = excluded.unsupported_reason, active = true, last_synced_at = now(), updated_at = now();
    v_upserted := v_upserted + 1;
  end loop;

  with deact as (
    update public.whatsapp_templates
    set active = false, updated_at = now()
    where doctor_id = p_doctor_id
      and active = true
      and not (meta_template_id = any(v_seen_ids))
    returning id
  )
  select count(*) into v_deactivated from deact;

  return jsonb_build_object('upserted', v_upserted, 'deactivated', v_deactivated, 'seen', array_length(v_seen_ids, 1));
end;$fn$;

revoke execute on function public.whatsapp_templates_sync_replace(uuid, uuid, jsonb) from public;
revoke execute on function public.whatsapp_templates_sync_replace(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function public.whatsapp_templates_sync_replace(uuid, uuid, jsonb) to service_role;
