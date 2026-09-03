# supabase/migrations/

O Supabase CLI aplica as migrations que estiverem AQUI, em ordem de nome
(`<YYYYMMDDHHMMSS>_nome.sql`).

## Estado atual

As migrations de produto estão em `../../migrations/` (`0001`–`0006`), no formato
`NNNN_nome.sql`. Elas **não foram aplicadas em produção** e não estão duplicadas
aqui para evitar divergência.

## Para usar o Supabase local

1. **Baseline**: gerar `00000000000000_baseline.sql` com o schema base atual
   (`users`, `doctors`, `leads`, policies, funções `is_admin`/`is_doctor_owner`/
   `user_has_doctor_access`, etc.). Fontes possíveis:
   - `pg_dump --schema-only` de um ambiente NÃO-produção;
   - ou recriar manualmente a partir do inventário em
     `docs/platform/00-current-state-audit.md` §2.4.
2. **Copiar** cada `../../migrations/000N_*.sql` para cá renomeando com timestamp
   crescente, mantendo a ordem `0003 → 0004 → 0005 → 0006`:
   ```
   00000000000003_r01_lockdown_campanhas_knowledge_base.sql
   00000000000004_users_status_pendente.sql
   00000000000005_webhook_events.sql
   00000000000006_campanha_envios.sql
   ```
   (Os `*.rollback.sql` NÃO entram aqui — rollback é manual.)
3. `npx supabase db reset` aplica baseline + as 4 + `seed.sql`.

## Regras

- Não aplicar nada em projeto remoto nesta fase.
- Baseline e cópias são trabalho de quem for rodar o Supabase local — não foram
  criados agora porque dependem de um dump que não deve vir de produção.
