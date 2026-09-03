#!/usr/bin/env node
// FASE 2.2 — Migração em lote de tokens em texto puro -> ciphertext.
//
// SEGURO POR PADRÃO:
//   - dry-run a menos que --apply seja passado;
//   - exige --env=<nome> como confirmação explícita do ambiente;
//   - recusa qualquer banco que não seja 127.0.0.1 / localhost nesta fase;
//   - lock via advisory lock — duas execuções simultâneas não coexistem;
//   - nunca imprime token, plaintext, ciphertext completo ou chave;
//   - só marca token_encryption_migrated_at após encrypt -> decrypt -> compare;
//   - não sobrescreve ciphertext já presente;
//   - exit code != 0 se houver qualquer falha.
//
// Uso:
//   DB_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
//   TOKEN_ENCRYPTION_ENABLED=true TOKEN_ENCRYPTION_ACTIVE_KEY=v1 \
//   TOKEN_ENCRYPTION_KEYRING='{"v1":"<base64 32 bytes>"}' \
//   TOKEN_LOOKUP_HMAC_KEY='<base64 >=32 bytes>' \
//   node scripts/migrate-token-encryption.js --env=local [--apply] [--batch=100]

import pg from 'pg';
import { loadCryptoState, TokenCipher, TokenLookup, buildAad } from '../src/lib/credentialVault.js';

const ADVISORY_LOCK_KEY = 0x70677832; // "pgx2"

function parseArgs(argv) {
  const args = { apply: false, env: null, batch: 100 };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--env=')) args.env = a.slice(6);
    else if (a.startsWith('--batch=')) args.batch = Math.max(1, Number(a.slice(8)) || 100);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return args;
}

function redactId(id) {
  const s = String(id);
  return s.length <= 8 ? s : `${s.slice(0, 8)}…`;
}

function assertLocalDb(connString) {
  let host;
  try {
    host = new URL(connString).hostname;
  } catch {
    throw new Error('DB_URL inválida');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`recusado: DB_URL aponta para "${host}" — esta fase só permite banco local`);
  }
}

async function migrateTable(client, { apply, batch }, spec) {
  const stats = { total: 0, migrated: 0, already: 0, invalid: 0, failed: 0 };
  let cursor = null;

  for (;;) {
    const params = cursor ? [cursor, batch] : [batch];
    const where = cursor ? `where ${spec.pk} > $1` : '';
    const { rows } = await client.query(
      `select ${spec.columns.join(', ')} from ${spec.table} ${where} order by ${spec.pk} limit $${cursor ? 2 : 1}`,
      params
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1][spec.pk];

    for (const row of rows) {
      const needs = spec.fields.filter((f) => row[f] != null && row[f] !== '' && (row[`${f}_encrypted`] == null || row[`${f}_encrypted`] === ''));
      if (needs.length === 0) {
        // conta como "já migrado" só se havia algo a migrar antes
        const hadSomething = spec.fields.some((f) => row[`${f}_encrypted`] != null);
        if (hadSomething) stats.already += 1;
        continue;
      }
      stats.total += 1;
      const patch = {};
      let ok = true;
      for (const field of needs) {
        try {
          const aad = buildAad({ ...spec.aad(row), field });
          const envelope = TokenCipher.encrypt(String(row[field]), aad);
          const roundtrip = TokenCipher.decrypt(envelope, aad);
          if (!TokenLookup.safeEquals(roundtrip, String(row[field]))) {
            ok = false;
            stats.invalid += 1;
            console.error(`  [invalid] ${spec.table} ${redactId(row[spec.pk])} campo=${field} round-trip divergente`);
            break;
          }
          patch[`${field}_encrypted`] = envelope;
          if (field === 'webhook_token') patch.webhook_token_lookup = TokenLookup.blindIndex(String(row[field]));
        } catch (err) {
          ok = false;
          stats.failed += 1;
          console.error(`  [failed] ${spec.table} ${redactId(row[spec.pk])} campo=${field}: ${err.message}`);
          break;
        }
      }
      if (!ok) continue;

      patch.token_encryption_migrated_at = new Date().toISOString();
      if (!apply) {
        stats.migrated += 1;
        console.log(`  [dry-run] ${spec.table} ${redactId(row[spec.pk])} -> ${Object.keys(patch).join(', ')}`);
        continue;
      }
      const setCols = Object.keys(patch);
      const setSql = setCols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      try {
        await client.query(`update ${spec.table} set ${setSql} where ${spec.pk} = $1`, [row[spec.pk], ...setCols.map((c) => patch[c])]);
        stats.migrated += 1;
        console.log(`  [applied] ${spec.table} ${redactId(row[spec.pk])}`);
      } catch (err) {
        stats.failed += 1;
        console.error(`  [failed] ${spec.table} ${redactId(row[spec.pk])} update: ${err.message}`);
      }
    }
  }
  return stats;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.env) throw new Error('faltou --env=<nome> (confirmação explícita do ambiente)');

  const connString = process.env.DB_URL || process.env.SUPABASE_DB_URL || process.env.SUPABASE_TEST_DB_URL;
  if (!connString) throw new Error('faltou DB_URL / SUPABASE_DB_URL');
  assertLocalDb(connString);

  // Estado de cripto — precisa estar habilitado e válido.
  const crypto = loadCryptoState();
  if (!crypto.enabled) throw new Error('TOKEN_ENCRYPTION_ENABLED != true — nada a fazer');

  console.log(`token-encryption migrate — env=${args.env} mode=${args.apply ? 'APPLY' : 'dry-run'} batch=${args.batch}`);

  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  let exitCode = 0;
  try {
    const lock = await client.query('select pg_try_advisory_lock($1) as ok', [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0].ok) throw new Error('outra execução já detém o lock — abortando');

    const integ = await migrateTable(client, args, {
      table: 'public.integrations',
      pk: 'id',
      fields: ['access_token', 'webhook_token'],
      columns: ['id', 'doctor_id', 'gateway', 'access_token', 'webhook_token', 'access_token_encrypted', 'webhook_token_encrypted', 'webhook_token_lookup'],
      aad: (row) => ({ table: 'integrations', recordId: row.id, scope: `doctor:${row.doctor_id}`, provider: row.gateway }),
    });

    const google = await migrateTable(client, args, {
      table: 'public.google_tokens',
      pk: 'user_id',
      fields: ['access_token', 'refresh_token'],
      columns: ['user_id', 'access_token', 'refresh_token', 'access_token_encrypted', 'refresh_token_encrypted'],
      aad: (row) => ({ table: 'google_tokens', recordId: row.user_id, scope: `user:${row.user_id}`, provider: 'google' }),
    });

    for (const [name, s] of [['integrations', integ], ['google_tokens', google]]) {
      console.log(`\n${name}: total=${s.total} migrado=${s.migrated} já=${s.already} inválido=${s.invalid} falho=${s.failed}`);
      if (s.invalid > 0 || s.failed > 0) exitCode = 1;
    }
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  } finally {
    await client.end();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`ERRO: ${err.message}`);
  process.exit(2);
});
