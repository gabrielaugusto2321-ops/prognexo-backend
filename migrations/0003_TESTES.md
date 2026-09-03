# R01 lockdown verification (local/staging only)

Run after reviewing/applying `0003` in a disposable local/staging project:

```sql
begin;
set local role anon;
select count(*) from public.campanhas; -- expected: permission denied
insert into public.knowledge_base default values; -- expected: permission denied
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select count(*) from public.campanhas; -- expected: permission denied (no rows exposed)
select count(*) from public.knowledge_base; -- expected: permission denied
reset role;
rollback;
```

REST check (use only a staging/local anon key):

```sh
curl -i 'https://STAGING_PROJECT.supabase.co/rest/v1/campanhas?select=*' -H 'apikey: STAGING_ANON_KEY'
curl -i 'https://STAGING_PROJECT.supabase.co/rest/v1/knowledge_base?select=*' -H 'apikey: STAGING_ANON_KEY'
```

Expected: HTTP 401/403 or PostgREST `permission denied`; never a row set.
