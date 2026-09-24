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
      if (/\bdoctors\s*\(/.test(selectStr) && row.doctor_id) {
        out.doctors = table('doctors').find((d) => d.id === row.doctor_id) || null;
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
        // campanhas.mensagem é NOT NULL na produção real (confirmado via
        // information_schema — o baseline.sql local está desatualizado nisso).
        // Simulado aqui pra pegar exatamente o bug de produção: campanha de
        // template gravando mensagem=null porque o backend nunca preenchia
        // um snapshot do corpo do template nesse modo.
        if (op === 'insert' && name === 'campanhas') {
          for (const item of items) {
            if (item.mensagem == null) {
              return Promise.resolve({ data: null, error: { code: '23502', message: 'null value in column "mensagem" of relation "campanhas" violates not-null constraint' } });
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
    lead_form_submit({ p_public_id, p_nome, p_email, p_telefone, p_telefone_normalizado, p_consent, p_page_origin, p_page_url, p_utm, p_ip_hash }) {
      if (typeof p_telefone_normalizado !== 'string' || !/^55[0-9]{10,11}$/.test(p_telefone_normalizado)) return rpcErr('invalid_phone');
      p_consent = !!p_consent;
      const form = table('lead_capture_forms').find((row) => row.public_id === p_public_id && row.active === true);
      if (!form) return rpcErr('form_not_found');
      // Sem o texto exibido não há prova: nunca aceitar o envio (espelha o SQL).
      if (!table('lead_capture_form_consent_versions').some((row) => row.form_id === form.id && row.version === form.consent_version)) return rpcErr('consent_version_missing');
      const now = new Date();
      const cryptoHash = (value) => {
        // Hash determinístico suficiente para o espelho em memória; o SQL usa SHA-256 real.
        let hash = 0; for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
        return `mock-sha256-${Math.abs(hash)}`;
      };
      const phoneHash = cryptoHash(p_telefone_normalizado);
      // Escopo estrito no médico do formulário. Lead legado sem telefone_normalizado
      // casa pelos dígitos do telefone bruto (com ou sem 55); o normalizado ganha.
      const digits = (value) => String(value ?? '').replace(/[^0-9]/g, '');
      const candidates = table('leads').filter((row) => row.doctor_id === form.doctor_id
        && (row.telefone_normalizado === p_telefone_normalizado
          || (row.telefone_normalizado == null && [p_telefone_normalizado, p_telefone_normalizado.slice(2)].includes(digits(row.telefone)))));
      candidates.sort((a, b) => Number(b.telefone_normalizado != null) - Number(a.telefone_normalizado != null));
      let lead = candidates[0];
      const recent = table('lead_capture_submissions').filter((row) => row.form_id === form.id && row.phone_hash === phoneHash && new Date(row.criado_em) >= new Date(now.getTime() - 600000));
      let outcome = 'unchanged'; let applied = false; let block = null;
      if (recent.length > 3) outcome = 'throttled';
      else if (!lead) {
        lead = { id: `mock-leads-${table('leads').length + 1}`, doctor_id: form.doctor_id, organization_id: form.organization_id ?? null,
          nome: p_nome, email: p_email, telefone: p_telefone, telefone_normalizado: p_telefone_normalizado,
          origem: 'formulario_captacao', origem_lead: form.name?.slice(0, 120), utm_source: p_utm?.utm_source ?? null,
          utm_campaign: p_utm?.utm_campaign ?? null, utm_criativo: p_utm?.utm_content ?? p_utm?.utm_criativo ?? null,
          journey_type: 'low_ticket', status_atual: form.pipeline_stage,
          whatsapp_authorization_status: p_consent ? 'autorizado' : 'pendente',
          whatsapp_authorization_at: p_consent ? now.toISOString() : null,
          whatsapp_authorization_source: p_consent ? `lead_form:${p_public_id}` : null };
        table('leads').push(lead); outcome = 'created'; applied = !!p_consent;
      } else {
        let changed = false;
        // Primeiro toque preservado: só preenche o que está NULL.
        for (const [field, value] of [['email',p_email],['telefone_normalizado',p_telefone_normalizado],['origem','formulario_captacao'],['utm_source',p_utm?.utm_source],['utm_campaign',p_utm?.utm_campaign],['utm_criativo',p_utm?.utm_content ?? p_utm?.utm_criativo]]) {
          if (lead[field] == null && value != null) { lead[field] = value; changed = true; }
        }
        if (p_consent) {
          const current = lead.whatsapp_authorization_status ?? 'pendente';
          if (current === 'pendente') {
            lead.whatsapp_authorization_status = 'autorizado'; lead.whatsapp_authorization_at = now.toISOString();
            lead.whatsapp_authorization_source = `lead_form:${p_public_id}`; applied = true; changed = true;
          } else if (current === 'opt_out') block = 'previous_opt_out';
          else if (current === 'recusado') block = 'previous_recusado';
          else if (current === 'autorizado') block = 'already_authorized';
        }
        outcome = changed ? 'updated' : 'unchanged';
      }
      // Cartão do funil: qualquer deal do lead conta; etapa do formulário só p/ lead novo.
      if (outcome !== 'throttled' && lead && !table('deals').some((row) => row.lead_id === lead.id)) {
        const stages = ['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta', 'fechado', 'perdido'];
        const etapa = outcome === 'created' ? form.pipeline_stage : (stages.includes(lead.status_atual) ? lead.status_atual : 'lead');
        table('deals').push({ id: `mock-deals-${table('deals').length + 1}`, lead_id: lead.id,
          etapa, sdr_responsavel_id: lead.sdr_responsavel_id ?? null, product_id: null });
      }
      const version = table('lead_capture_form_consent_versions').find((row) => row.form_id === form.id && row.version === form.consent_version);
      table('lead_capture_submissions').push({ id: `mock-lead_capture_submissions-${table('lead_capture_submissions').length + 1}`,
        form_id: form.id, doctor_id: form.doctor_id, organization_id: form.organization_id ?? null, lead_id: lead?.id ?? null,
        phone_hash: phoneHash, consent_given: !!p_consent, consent_applied: applied, consent_block_reason: block,
        consent_version: form.consent_version, consent_text_snapshot: version?.consent_text ?? '', consented_at: p_consent ? now.toISOString() : null,
        page_origin: p_page_origin, page_url: p_page_url?.slice(0, 500) ?? null, utm: p_utm || {}, ip_hash: p_ip_hash,
        outcome, criado_em: now.toISOString() });
      return ok([{ lead_id: lead?.id ?? null, outcome, consent_applied: applied, redirect_url: form.redirect_url ?? null, success_message: form.success_message ?? null }]);
    },
    // Espelha migrations/0021_doctor_courtesy_expiration.sql's
    // doctor_access_gate: idem à decisão de bloqueio em uma única "query".
    // Nunca bloqueia em caso de ambiguidade (ver comentário na migration).
    doctor_access_gate({ p_user_id, p_organization_id }) {
      const user = table('users').find((u) => u.id === p_user_id);
      const isAdmin = user?.role === 'admin'
        || table('platform_admins').some((pa) => pa.user_id === p_user_id);
      if (isAdmin) return ok([{ blocked: false, reason: null }]);

      let doctorId = null;
      if (p_organization_id) {
        const map = table('organization_doctor_map').find((m) => m.organization_id === p_organization_id);
        doctorId = map?.doctor_id ?? null;
      } else {
        const owned = table('doctors').filter((d) => d.owner_user_id === p_user_id);
        if (owned.length === 1) {
          doctorId = owned[0].id;
        } else {
          const access = table('user_doctor_access').filter((a) => a.user_id === p_user_id);
          if (access.length === 1) doctorId = access[0].doctor_id;
        }
      }
      if (!doctorId) return ok([{ blocked: false, reason: null }]);

      const doctor = table('doctors').find((d) => d.id === doctorId);
      if (!doctor) return ok([{ blocked: false, reason: null }]);
      if (doctor.status === 'pausado') return ok([{ blocked: true, reason: 'account_paused' }]);
      if (doctor.courtesy_expires_at && new Date(doctor.courtesy_expires_at).getTime() < Date.now()) {
        return ok([{ blocked: true, reason: 'courtesy_expired' }]);
      }
      return ok([{ blocked: false, reason: null }]);
    },
    // Espelha migrations/0019_signup_tenant_provisioning.sql: idempotência
    // POR ETAPA (nunca um atalho "doctor+map existem -> retorna tudo pronto").
    // Uma chamada repetida, ou uma retomada de estado parcial (doctor sem
    // membership, ou membership sem membership_units), precisa completar
    // exatamente o que falta, sem duplicar nada.
    reassign_lead_closer({ p_lead_id, p_new_sdr_id, p_actor_user_id }) {
      const lead = table('leads').find((row) => row.id === p_lead_id);
      if (!lead) return rpcErr('lead_not_found');
      const doctor = table('doctors').find((row) => row.id === lead.doctor_id);
      const map = table('organization_doctor_map').find((row) => row.doctor_id === lead.doctor_id);
      const organizationId = lead.organization_id || map?.organization_id || null;
      const actor = table('users').find((row) => row.id === p_actor_user_id);
      const actorMembership = table('memberships').find((row) => row.organization_id === organizationId
        && row.user_id === p_actor_user_id && row.status === 'active');
      const actorAllowed = actor?.role === 'admin'
        || (actor?.role === 'doctor' && doctor?.owner_user_id === actor.id)
        || table('platform_admins').some((row) => row.user_id === p_actor_user_id)
        || ['organization_owner', 'organization_admin', 'platform_admin'].includes(actorMembership?.role);
      if (!actorAllowed) return rpcErr('forbidden');
      if (p_new_sdr_id !== null) {
        const target = table('users').find((row) => row.id === p_new_sdr_id);
        const legacyCloser = target?.role === 'closer' && table('user_doctor_access')
          .some((row) => row.user_id === p_new_sdr_id && row.doctor_id === lead.doctor_id);
        const tenantCloser = organizationId && table('memberships').some((row) => row.organization_id === organizationId
          && row.user_id === p_new_sdr_id && row.role === 'closer' && row.status === 'active');
        if (!target || target.ativo !== true || (!legacyCloser && !tenantCloser)) return rpcErr('invalid_closer');
      }
      lead.sdr_responsavel_id = p_new_sdr_id;
      for (const deal of table('deals')) {
        if (deal.lead_id === p_lead_id) deal.sdr_responsavel_id = p_new_sdr_id;
      }
      return ok({ ...lead });
    },
    signup_provision_tenant({ p_auth_user_id, p_nome, p_email, p_clinica_nome }) {
      const clinicName = p_clinica_nome?.trim();

      if (!table('users').some((u) => u.id === p_auth_user_id)) {
        table('users').push({ id: p_auth_user_id, nome: p_nome, email: p_email, role: 'doctor', ativo: false, status: 'pending' });
      }

      let doctor = table('doctors').find((d) => d.owner_user_id === p_auth_user_id);
      if (!doctor) {
        doctor = { id: `mock-doctors-${table('doctors').length + 1}`, owner_user_id: p_auth_user_id, nome: clinicName || p_nome, status: 'prospect', plano: 'gratuito' };
        table('doctors').push(doctor);
      }

      let map = table('organization_doctor_map').find((m) => m.doctor_id === doctor.id);
      let organizationId = map?.organization_id;
      let unitId = map?.default_unit_id;

      if (!organizationId) {
        organizationId = `mock-organizations-${table('organizations').length + 1}`;
        table('organizations').push({ id: organizationId, name: clinicName || `Organizacao ${doctor.id.slice(0, 8)}`, slug: `org-${doctor.id.replaceAll('-', '')}`, status: 'active' });
      }

      if (!unitId) {
        unitId = table('units').find((u) => u.organization_id === organizationId)?.id;
      }
      if (!unitId) {
        unitId = `mock-units-${table('units').length + 1}`;
        table('units').push({ id: unitId, organization_id: organizationId, name: 'Unidade principal', status: 'active', timezone: 'America/Sao_Paulo' });
      }

      if (!map) {
        table('organization_doctor_map').push({ organization_id: organizationId, doctor_id: doctor.id, default_unit_id: unitId });
      }

      let membership = table('memberships').find((m) => m.organization_id === organizationId && m.user_id === p_auth_user_id);
      if (!membership) {
        membership = { id: `mock-memberships-${table('memberships').length + 1}`, organization_id: organizationId, user_id: p_auth_user_id, role: 'organization_owner', status: 'active' };
        table('memberships').push(membership);
      }

      if (!table('membership_units').some((mu) => mu.membership_id === membership.id && mu.unit_id === unitId)) {
        table('membership_units').push({ membership_id: membership.id, unit_id: unitId });
      }

      return ok([{ doctor_id: doctor.id, organization_id: organizationId, unit_id: unitId, membership_id: membership.id }]);
    },
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
        // Espelha o comportamento real do GoTrue: type:'invite' pra um e-mail
        // que já existe em auth.users falha com email_exists (422) — foi
        // exatamente esse erro em produção que provou que resend-invite não
        // pode reusar 'invite' pra reenviar acesso a uma conta já criada.
        // type:'recovery' é o mecanismo correto pra gerar novo link de acesso
        // (definir/redefinir senha) pra um usuário que já existe.
        generateLink: vi.fn(async ({ type, email }) => {
          const exists = (tables.users || []).some((u) => u.email === email);
          if (type === 'invite' && exists) {
            return {
              data: { properties: null },
              error: { message: 'User with this email address has already been registered', status: 422, code: 'email_exists' },
            };
          }
          return {
            data: { properties: { action_link: `https://mock.local/${type}/${email}`, verification_type: type } },
            error: null,
          };
        }),
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
