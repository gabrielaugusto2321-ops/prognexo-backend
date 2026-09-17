alter table public.leads
  add column telefone_normalizado text,
  add column origem_lead text,
  add column indicado_por text,
  add column whatsapp_authorization_status text not null default 'pendente',
  add column whatsapp_authorization_at timestamptz,
  add column whatsapp_authorization_source text,
  add constraint leads_whatsapp_authorization_status_check
    check (whatsapp_authorization_status in ('pendente', 'autorizado', 'recusado', 'opt_out'));

create table public.lead_imports (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  created_by uuid references public.users(id) on delete set null,
  nome_lista text not null,
  filename text not null,
  file_hash text not null,
  status text not null default 'concluido',
  total integer not null default 0,
  criados integer not null default 0,
  atualizados integer not null default 0,
  duplicados integer not null default 0,
  invalidos integer not null default 0,
  criado_em timestamptz not null default now(),
  concluido_em timestamptz,
  authorization_declared_by uuid references public.users(id) on delete set null,
  authorization_declared_at timestamptz,
  authorization_declaration_version text,
  unique (doctor_id, file_hash)
);

create index lead_imports_doctor_idx on public.lead_imports (doctor_id);

create table public.lead_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.lead_imports(id) on delete cascade,
  row_number integer not null,
  lead_id uuid references public.leads(id) on delete set null,
  status text not null,
  error_code text,
  phone_hash text,
  criado_em timestamptz not null default now(),
  unique (import_id, row_number)
);

create index lead_import_rows_import_idx on public.lead_import_rows (import_id);
create index lead_import_rows_lead_idx on public.lead_import_rows (lead_id);

alter table public.lead_imports enable row level security;
alter table public.lead_import_rows enable row level security;
revoke all on public.lead_imports from anon, authenticated;
revoke all on public.lead_import_rows from anon, authenticated;

alter table public.campanhas
  add column import_id uuid references public.lead_imports(id);
