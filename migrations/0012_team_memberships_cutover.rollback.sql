-- Rollback ESTRUTURAL da 0012. NÃO toca memberships/membership_units/
-- organization_doctor_map/platform_admins (são da 0008) nem user_doctor_access/
-- doctors/users. Remove só o que esta migration criou.

drop function if exists public.team_backfill_reconcile();
drop function if exists public.team_member_set_units(uuid, uuid, uuid, uuid[]);
drop function if exists public.team_member_remove(uuid, uuid, uuid);
drop function if exists public.team_member_set_status(uuid, uuid, uuid, text);
drop function if exists public.team_member_change_role(uuid, uuid, uuid, text);
drop function if exists public.team_member_add(uuid, uuid, uuid, text, uuid[]);
drop function if exists public.team_sync_legacy_bridge(uuid, uuid, text, boolean);
drop function if exists public.team_role_grantable(text, text);
drop function if exists public.team_actor_can_manage_target(text, text, boolean);
drop function if exists public.team_actor_is_manager(text);
drop function if exists public.team_actor_role(uuid, uuid);

drop table if exists public.team_backfill_reconciliation;
drop table if exists public.team_membership_events;
