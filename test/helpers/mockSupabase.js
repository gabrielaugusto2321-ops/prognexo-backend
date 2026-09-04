import { vi } from 'vitest';

// Mock table-driven do cliente Supabase. Suporta o subconjunto de operações que
// os handlers usam: select/insert/update/upsert/delete + eq/in/order/limit/gte/lte
// + single/maybeSingle. Filtros de igualdade são aplicados sobre as fixtures.
//
// uso:
//   const db = makeDb({ leads: [{ id: 'l1', doctor_id: 'A' }], doctors: [...] });
//   vi.mock('../src/lib/supabase.js', () => ({ supabase: db.client }));

export function makeDb(initial = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));

  const authState = {
    users: {}, // token -> { id, email, email_confirmed_at }
  };

  function table(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function makeQuery(name) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let onConflictIgnore = false;
    let selectStr = '*';

    // Resolve embeds simples do PostgREST usados nos handlers:
    //  - deals: leads(...)   via deals.lead_id -> leads.id
    //  - conversations/events: leads(...) via lead_id
    function withEmbeds(row) {
      if (!row || typeof selectStr !== 'string') return row;
      const out = { ...row };
      if (/\bleads\s*!?\w*\s*\(/.test(selectStr) && row.lead_id) {
        out.leads = table('leads').find((l) => l.id === row.lead_id) || null;
      }
      // memberships -> organizations(...) via organization_id
      if (/\borganizations\s*\(/.test(selectStr) && row.organization_id) {
        out.organizations = table('organizations').find((o) => o.id === row.organization_id) || null;
      }
      // memberships -> membership_units( units(...) ) via membership_id -> unit_id
      if (/\bmembership_units\s*\(/.test(selectStr) && row.id) {
        out.membership_units = table('membership_units')
          .filter((mu) => mu.membership_id === row.id)
          .map((mu) => ({
            unit_id: mu.unit_id,
            units: /units\s*\(/.test(selectStr)
              ? table('units').find((u) => u.id === mu.unit_id) || null
              : undefined,
          }));
      }
      return out;
    }

    function fieldValue(row, col) {
      if (!col.includes('.')) return row[col];
      // caminho tipo "leads.doctor_id" sobre o embed resolvido
      return col.split('.').reduce((v, k) => v?.[k], withEmbeds(row));
    }

    function applyFilters(rows) {
      return rows.filter((row) =>
        filters.every(([kind, col, val]) => {
          const cur = fieldValue(row, col);
          if (kind === 'eq') return cur === val;
          if (kind === 'in') return val.includes(cur);
          if (kind === 'gte') return cur >= val;
          if (kind === 'lte') return cur <= val;
          if (kind === 'gt') return cur > val;
          if (kind === 'lt') return cur != null && cur < val;
          return true;
        })
      );
    }

    function resolve(single) {
      const rows = table(name);
      if (op === 'insert' || op === 'upsert') {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        const CONFLICT_KEYS = ['provider', 'external_event_id', 'campanha_id', 'lead_id', 'gateway', 'gateway_transaction_id', 'doctor_id', 'user_id'];
        for (const item of items) {
          const row = { id: item.id || `mock-${name}-${rows.length + 1}`, ...item };
          if (op === 'upsert') {
            const present = CONFLICT_KEYS.filter((k) => item[k] !== undefined);
            const dup = present.length
              ? rows.find((r) => present.every((k) => r[k] === item[k]))
              : null;
            if (dup) {
              if (onConflictIgnore) continue; // ignoreDuplicates
              Object.assign(dup, item); // upsert -> update
              inserted.push(dup);
              continue;
            }
          }
          rows.push(row);
          inserted.push(row);
        }
        const result = single ? inserted[0] ?? null : inserted;
        return Promise.resolve({ data: result, error: null });
      }
      if (op === 'update') {
        const matched = applyFilters(rows);
        for (const row of matched) Object.assign(row, payload);
        const result = single ? matched[0] ?? null : matched;
        return Promise.resolve({ data: result, error: null });
      }
      if (op === 'delete') {
        const matched = applyFilters(rows);
        for (const row of matched) rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ data: matched, error: null });
      }
      // select
      const matched = applyFilters(rows).map(withEmbeds);
      if (single) {
        if (matched.length === 0) {
          return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        }
        return Promise.resolve({ data: matched[0], error: null });
      }
      return Promise.resolve({ data: matched, error: null });
    }

    const q = {
      select(s) { if (typeof s === 'string') selectStr = s; return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      upsert(p, opts) { op = 'upsert'; payload = p; onConflictIgnore = !!opts?.ignoreDuplicates; return q; },
      delete() { op = 'delete'; return q; },
      eq(col, val) { filters.push(['eq', col, val]); return q; },
      in(col, val) { filters.push(['in', col, val]); return q; },
      gte(col, val) { filters.push(['gte', col, val]); return q; },
      lte(col, val) { filters.push(['lte', col, val]); return q; },
      gt(col, val) { filters.push(['gt', col, val]); return q; },
      lt(col, val) { filters.push(['lt', col, val]); return q; },
      order() { return q; },
      limit() { return q; },
      maybeSingle() { return resolve(true).then((r) => (r.error?.code === 'PGRST116' ? { data: null, error: null } : r)); },
      single() { return resolve(true); },
      then(onFulfilled, onRejected) { return resolve(false).then(onFulfilled, onRejected); },
    };
    return q;
  }

  const client = {
    from: vi.fn((name) => makeQuery(name)),
    auth: {
      getUser: vi.fn(async (token) => {
        const u = authState.users[token];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      }),
      admin: {
        inviteUserByEmail: vi.fn(async (email) => ({
          data: { user: { id: `invited-${email}` } },
          error: null,
        })),
        deleteUser: vi.fn(async () => ({ data: {}, error: null })),
      },
    },
  };

  return {
    client,
    tables,
    setAuthUser(token, user) { authState.users[token] = user; },
  };
}
