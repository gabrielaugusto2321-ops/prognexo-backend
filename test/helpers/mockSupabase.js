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

  // Injeção de falha controlada — simula uma queda de banco no meio de um
  // laço de escrita (ex.: import de CSV) sem precisar de um mock manual por
  // teste. `failNextWrite('leads', 'insert')` faz a PRÓXIMA operação desse
  // tipo nessa tabela devolver um erro, uma única vez.
  const pendingFailures = [];
  // `skip`: quantas chamadas boas deixar passar antes de começar a falhar —
  // permite simular uma quebra no MEIO de um laço (ex.: linha 1 de um CSV
  // grava com sucesso, linha 2 quebra), não só na primeira operação.
  function failNextWrite(tableName, opName = 'insert', times = 1, skip = 0) {
    pendingFailures.push({ table: tableName, op: opName, remaining: times, skip });
  }
  function consumeFailure(tableName, opName) {
    const entry = pendingFailures.find((f) => f.table === tableName && f.op === opName && (f.remaining > 0 || f.skip > 0));
    if (!entry) return false;
    if (entry.skip > 0) { entry.skip -= 1; return false; }
    entry.remaining -= 1;
    return true;
  }

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
      // memberships -> users(...) via user_id
      if (/\busers\s*\(/.test(selectStr) && row.user_id) {
        out.users = table('users').find((u) => u.id === row.user_id) || null;
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
          if (kind === 'is') return (val === null ? cur == null : cur === val);
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
      if ((op === 'insert' || op === 'update' || op === 'upsert') && consumeFailure(name, op)) {
        return Promise.resolve({ data: null, error: { code: 'db_down', message: 'simulated failure (failNextWrite)' } });
      }
      if (op === 'insert' || op === 'upsert') {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        const CONFLICT_KEYS = ['provider', 'external_event_id', 'campanha_id', 'lead_id', 'gateway', 'gateway_transaction_id', 'doctor_id', 'user_id'];
        // `lead_imports` tem unique(doctor_id, file_hash) — simulado aqui (só
        // pro INSERT puro, não-upsert) pra testar a corrida de duas requisições
        // de commit idênticas concorrentes (FASE 1, correção 5).
        if (op === 'insert' && name === 'lead_imports') {
          for (const item of items) {
            const dup = rows.find((r) => r.doctor_id === item.doctor_id && r.file_hash === item.file_hash);
            if (dup) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "lead_imports_doctor_id_file_hash_key"' } });
            }
          }
        }
        // leads tem um índice único PARCIAL (doctor_id, whatsapp_wa_id) WHERE
        // whatsapp_wa_id IS NOT NULL (migration 0016) — simulado aqui só pro
        // INSERT puro, pra testar a corrida de duas mensagens concorrentes do
        // mesmo wa_id criando o mesmo lead de quarentena (nunca duas).
        if (op === 'insert' && name === 'leads') {
          for (const item of items) {
            if (item.whatsapp_wa_id == null) continue;
            const dup = rows.find((r) => r.doctor_id === item.doctor_id && r.whatsapp_wa_id === item.whatsapp_wa_id);
            if (dup) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "leads_doctor_whatsapp_wa_id_key"' } });
            }
          }
        }
        // deals tem um índice único PARCIAL (lead_id) WHERE product_id IS NULL
        // (migration 0018) — simulado aqui só pro INSERT puro, pra testar a
        // corrida de dois reparos concorrentes do mesmo lote de import criando
        // dois cartões de pipeline pro mesmo lead (nunca dois).
        if (op === 'insert' && name === 'deals') {
          for (const item of items) {
            if (item.product_id != null) continue;
            const dup = rows.find((r) => r.lead_id === item.lead_id && r.product_id == null);
            if (dup) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "deals_lead_id_pipeline_unique"' } });
            }
          }
        }
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
      is(col, val) { filters.push(['is', col, val]); return q; },
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

  // ---------------------------------------------------------------------
  // FASE 2.6 — espelho em JS das RPCs de team_member_* (migration 0012),
  // só para os testes de CONTRATO HTTP da rota (auth gate, mapeamento de
  // erro, shape de resposta). A correção de segurança de verdade (RLS,
  // search_path, escalonamento, atomicidade, último owner) é validada contra
  // Postgres real em test/rls/team-memberships.rls.test.js — este mock NUNCA
  // substitui aquela prova.
  // ---------------------------------------------------------------------
  const GRANTABLE = {
    platform_admin: () => true,
    organization_owner: (role) => role !== 'platform_admin',
    organization_admin: (role) => ['manager', 'closer', 'receptionist', 'professional', 'financial', 'viewer'].includes(role),
  };
  // espelha team_actor_can_manage_target (migration 0012): hierarquia
  // estrita — organization_admin nunca toca outro admin/owner/platform_admin
  // nem a si mesmo; só owner/platform_admin administram admin/owner.
  function canManageTarget(actorRole, targetRole, isSelf) {
    if (actorRole === 'platform_admin') return true;
    if (actorRole === 'organization_admin' && isSelf) return false;
    if (actorRole === 'organization_owner') return targetRole !== 'platform_admin';
    if (actorRole === 'organization_admin') return ['manager', 'closer', 'receptionist', 'professional', 'financial', 'viewer'].includes(targetRole);
    return false;
  }
  function rpcActorRole(orgId, actorId) {
    const isPlatformAdmin =
      table('platform_admins').some((p) => p.user_id === actorId) ||
      table('users').some((u) => u.id === actorId && u.role === 'admin');
    if (isPlatformAdmin) return 'platform_admin';
    const m = table('memberships').find((x) => x.organization_id === orgId && x.user_id === actorId && x.status === 'active');
    return m?.role ?? null;
  }
  function rpcSyncBridge(orgId, userId, role, active) {
    const map = table('organization_doctor_map').find((m) => m.organization_id === orgId);
    if (!map) return;
    const uda = table('user_doctor_access');
    const idx = uda.findIndex((r) => r.user_id === userId && r.doctor_id === map.doctor_id);
    if (role === 'closer' && active) {
      if (idx === -1) uda.push({ user_id: userId, doctor_id: map.doctor_id });
    } else if (idx !== -1) {
      uda.splice(idx, 1);
    }
  }
  function rpcAudit(orgId, actorId, targetId, action, result, detail) {
    table('team_membership_events').push({
      id: `mock-tme-${table('team_membership_events').length + 1}`,
      organization_id: orgId, actor_user_id: actorId, target_user_id: targetId,
      action, result, detail: detail || {}, created_at: new Date().toISOString(),
    });
  }
  function rpcErr(message) { return { data: null, error: { message } }; }
  function ok(data) { return { data, error: null }; }

  const RPCS = {
    team_member_add({ p_organization_id, p_actor_user_id, p_target_user_id, p_role, p_unit_ids }) {
      if (!table('organizations').some((o) => o.id === p_organization_id)) return rpcErr('not_found');
      if (!table('users').some((u) => u.id === p_target_user_id)) return rpcErr('not_found');
      const actorRole = rpcActorRole(p_organization_id, p_actor_user_id);
      if (!actorRole || !['organization_owner', 'organization_admin', 'platform_admin'].includes(actorRole)) return rpcErr('forbidden');
      if (!GRANTABLE[actorRole](p_role)) return rpcErr('forbidden');
      if (table('memberships').some((m) => m.organization_id === p_organization_id && m.user_id === p_target_user_id)) return rpcErr('conflict');
      const units = table('units');
      for (const uid of p_unit_ids || []) {
        if (!units.some((u) => u.id === uid && u.organization_id === p_organization_id)) return rpcErr('unit_not_in_organization');
      }
      const id = `mock-membership-${table('memberships').length + 1}`;
      table('memberships').push({ id, organization_id: p_organization_id, user_id: p_target_user_id, role: p_role, status: 'active' });
      for (const uid of p_unit_ids || []) table('membership_units').push({ membership_id: id, unit_id: uid });
      rpcSyncBridge(p_organization_id, p_target_user_id, p_role, true);
      rpcAudit(p_organization_id, p_actor_user_id, p_target_user_id, 'add', 'success', { role: p_role });
      return ok({ membership_id: id, role: p_role, status: 'active' });
    },
    team_member_change_role({ p_organization_id, p_actor_user_id, p_target_user_id, p_new_role }) {
      const m = table('memberships').find((x) => x.organization_id === p_organization_id && x.user_id === p_target_user_id);
      if (!m) return rpcErr('not_found');
      const actorRole = rpcActorRole(p_organization_id, p_actor_user_id);
      if (!actorRole || !['organization_owner', 'organization_admin', 'platform_admin'].includes(actorRole)) return rpcErr('forbidden');
      if (!GRANTABLE[actorRole](p_new_role)) return rpcErr('forbidden');
      if (!canManageTarget(actorRole, m.role, p_actor_user_id === p_target_user_id)) return rpcErr('forbidden');
      if (m.role === 'organization_owner' && p_new_role !== 'organization_owner') {
        const owners = table('memberships').filter((x) => x.organization_id === p_organization_id && x.role === 'organization_owner' && x.status === 'active');
        if (owners.length <= 1) return rpcErr('last_owner_protected');
      }
      const from = m.role;
      m.role = p_new_role;
      rpcSyncBridge(p_organization_id, p_target_user_id, p_new_role, m.status === 'active');
      rpcAudit(p_organization_id, p_actor_user_id, p_target_user_id, 'change_role', 'success', { from, to: p_new_role });
      return ok({ role: m.role, status: m.status });
    },
    team_member_set_status({ p_organization_id, p_actor_user_id, p_target_user_id, p_new_status }) {
      const m = table('memberships').find((x) => x.organization_id === p_organization_id && x.user_id === p_target_user_id);
      if (!m) return rpcErr('not_found');
      const actorRole = rpcActorRole(p_organization_id, p_actor_user_id);
      if (!actorRole || !['organization_owner', 'organization_admin', 'platform_admin'].includes(actorRole)) return rpcErr('forbidden');
      if (!canManageTarget(actorRole, m.role, p_actor_user_id === p_target_user_id)) return rpcErr('forbidden');
      if (m.role === 'organization_owner' && p_new_status === 'suspended') {
        const owners = table('memberships').filter((x) => x.organization_id === p_organization_id && x.role === 'organization_owner' && x.status === 'active');
        if (owners.length <= 1) return rpcErr('last_owner_protected');
      }
      m.status = p_new_status;
      rpcSyncBridge(p_organization_id, p_target_user_id, m.role, p_new_status === 'active');
      rpcAudit(p_organization_id, p_actor_user_id, p_target_user_id, p_new_status === 'suspended' ? 'suspend' : 'reactivate', 'success', { to: p_new_status });
      return ok({ role: m.role, status: m.status });
    },
    team_member_remove({ p_organization_id, p_actor_user_id, p_target_user_id }) {
      const rows = table('memberships');
      const m = rows.find((x) => x.organization_id === p_organization_id && x.user_id === p_target_user_id);
      if (!m) return rpcErr('not_found');
      const actorRole = rpcActorRole(p_organization_id, p_actor_user_id);
      if (!actorRole || !['organization_owner', 'organization_admin', 'platform_admin'].includes(actorRole)) return rpcErr('forbidden');
      if (!canManageTarget(actorRole, m.role, p_actor_user_id === p_target_user_id)) return rpcErr('forbidden');
      if (m.role === 'organization_owner') {
        const owners = rows.filter((x) => x.organization_id === p_organization_id && x.role === 'organization_owner' && x.status === 'active');
        if (owners.length <= 1) return rpcErr('last_owner_protected');
      }
      rows.splice(rows.indexOf(m), 1);
      const mu = table('membership_units');
      for (let i = mu.length - 1; i >= 0; i -= 1) if (mu[i].membership_id === m.id) mu.splice(i, 1);
      rpcSyncBridge(p_organization_id, p_target_user_id, m.role, false);
      rpcAudit(p_organization_id, p_actor_user_id, p_target_user_id, 'remove', 'success', { role: m.role });
      return ok({ removed: true });
    },
    team_member_set_units({ p_organization_id, p_actor_user_id, p_target_user_id, p_unit_ids }) {
      const m = table('memberships').find((x) => x.organization_id === p_organization_id && x.user_id === p_target_user_id);
      if (!m) return rpcErr('not_found');
      const actorRole = rpcActorRole(p_organization_id, p_actor_user_id);
      if (!actorRole || !['organization_owner', 'organization_admin', 'platform_admin'].includes(actorRole)) return rpcErr('forbidden');
      if (!canManageTarget(actorRole, m.role, p_actor_user_id === p_target_user_id)) return rpcErr('forbidden');
      const units = table('units');
      for (const uid of p_unit_ids || []) {
        if (!units.some((u) => u.id === uid && u.organization_id === p_organization_id)) return rpcErr('unit_not_in_organization');
      }
      const mu = table('membership_units');
      for (let i = mu.length - 1; i >= 0; i -= 1) if (mu[i].membership_id === m.id) mu.splice(i, 1);
      for (const uid of p_unit_ids || []) mu.push({ membership_id: m.id, unit_id: uid });
      rpcAudit(p_organization_id, p_actor_user_id, p_target_user_id, 'set_units', 'success', { unit_count: (p_unit_ids || []).length });
      return ok({ unit_ids: p_unit_ids });
    },

    // FASE 2 — espelha migrations/0017_whatsapp_template_campaigns.sql:
    // upsert de todos os templates recebidos, active=false só pros que já
    // existiam e não vieram nesta lista, NUNCA deleta linha nenhuma.
    whatsapp_templates_sync_replace({ p_doctor_id, p_organization_id, p_templates }) {
      if (!p_doctor_id) return rpcErr('invalid_argument');
      if (!table('doctors').some((d) => d.id === p_doctor_id)) return rpcErr('not_found');
      const items = Array.isArray(p_templates) ? p_templates : [];
      const seenIds = new Set(items.map((i) => i.meta_template_id));
      const rows = table('whatsapp_templates');
      let upserted = 0;
      for (const item of items) {
        if (!item.meta_template_id) return rpcErr('invalid_argument');
        const existing = rows.find((r) => r.doctor_id === p_doctor_id && r.meta_template_id === item.meta_template_id);
        const now = new Date().toISOString();
        if (existing) {
          Object.assign(existing, {
            organization_id: p_organization_id, nome: item.nome, idioma: item.idioma, categoria: item.categoria,
            status: item.status, parameter_format: item.parameter_format, componentes: item.componentes || [],
            body_text: item.body_text, body_variable_count: item.body_variable_count ?? 0,
            supported: !!item.supported, unsupported_reason: item.unsupported_reason ?? null,
            active: true, last_synced_at: now, updated_at: now,
          });
        } else {
          rows.push({
            id: `mock-whatsapp_templates-${rows.length + 1}`,
            doctor_id: p_doctor_id, organization_id: p_organization_id, meta_template_id: item.meta_template_id,
            nome: item.nome, idioma: item.idioma, categoria: item.categoria, status: item.status,
            parameter_format: item.parameter_format, componentes: item.componentes || [],
            body_text: item.body_text, body_variable_count: item.body_variable_count ?? 0,
            supported: !!item.supported, unsupported_reason: item.unsupported_reason ?? null,
            active: true, last_synced_at: now, created_at: now, updated_at: now,
          });
        }
        upserted += 1;
      }
      let deactivated = 0;
      for (const row of rows) {
        if (row.doctor_id === p_doctor_id && row.active && !seenIds.has(row.meta_template_id)) {
          row.active = false;
          row.updated_at = new Date().toISOString();
          deactivated += 1;
        }
      }
      return ok({ upserted, deactivated, seen: items.length });
    },
  };

  const client = {
    from: vi.fn((name) => makeQuery(name)),
    rpc: vi.fn(async (name, params) => {
      const fn = RPCS[name];
      if (!fn) return { data: null, error: { message: `mock rpc not implemented: ${name}` } };
      return fn(params || {});
    }),
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
    failNextWrite,
  };
}
