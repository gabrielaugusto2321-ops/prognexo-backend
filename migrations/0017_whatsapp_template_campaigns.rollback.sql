drop function if exists public.whatsapp_templates_sync_replace(uuid, uuid, jsonb);

drop index if exists public.campanha_envios_message_id_key;
alter table public.campanha_envios drop column if exists envio_iniciado_em;
alter table public.campanha_envios drop column if exists meta_error_code;
alter table public.campanha_envios drop column if exists meta_status_at;
alter table public.campanha_envios drop column if exists meta_status;
alter table public.campanha_envios drop column if exists message_id;

alter table public.campanhas drop column if exists template_snapshot;
alter table public.campanhas drop column if exists template_variable_map;
alter table public.campanhas drop column if exists whatsapp_template_id;
alter table public.campanhas drop constraint if exists campanhas_modo_envio_check;
alter table public.campanhas drop column if exists modo_envio;

drop table if exists public.whatsapp_templates;
