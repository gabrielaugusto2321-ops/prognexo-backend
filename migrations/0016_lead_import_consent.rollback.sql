alter table public.campanhas drop column if exists import_id;

drop table if exists public.lead_import_rows;
alter table public.lead_imports drop column if exists authorization_declaration_version;
alter table public.lead_imports drop column if exists authorization_declared_at;
alter table public.lead_imports drop column if exists authorization_declared_by;
drop table if exists public.lead_imports;

drop index if exists public.leads_doctor_whatsapp_wa_id_key;
alter table public.leads drop constraint if exists leads_whatsapp_authorization_status_check;
alter table public.leads drop column if exists whatsapp_wa_id;
alter table public.leads drop column if exists whatsapp_authorization_source;
alter table public.leads drop column if exists whatsapp_authorization_at;
alter table public.leads drop column if exists whatsapp_authorization_status;
alter table public.leads drop column if exists indicado_por;
alter table public.leads drop column if exists origem_lead;
alter table public.leads drop column if exists telefone_normalizado;
