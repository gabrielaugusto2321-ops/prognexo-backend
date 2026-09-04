import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.3 / regressão FASE 2.3A — shadow-read da equipe:
//   user_doctor_access ∪ {owner} × memberships. Só REGISTRA divergência.

process.env.NODE_ENV = 'test';
process.env.TENANT_CORE_ENABLED = 'true';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
const { shadowCompareTeam } = await import('../src/lib/teamShadowRead.js');

const DOC_A = 'doc-a';
const ORG_A = 'org-a';
const OWNER = 'u-owner';
const CLOSER = 'u-closer';
const GHOST = 'u-ghost'; // membership sem user_doctor_access

function seed(extra = {}) {
  db = makeDb({
    doctors: [{ id: DOC_A, owner_user_id: OWNER }],
    organization_doctor_map: [{ organization_id: ORG_A, doctor_id: DOC_A }],
    user_doctor_access: [{ user_id: CLOSER, doctor_id: DOC_A }],
    memberships: [
      { organization_id: ORG_A, user_id: OWNER, role: 'organization_owner', status: 'active' },
      { organization_id: ORG_A, user_id: CLOSER, role: 'closer', status: 'active' },
    ],
    ...extra,
  });
}
const req = () => ({ log: { warn: vi.fn(), error: vi.fn() } });

describe('shadowCompareTeam', () => {
  beforeEach(() => seed());

  it('seed coerente (owner + closer): match=true, sem log.warn', async () => {
    const r = req();
    const rep = await shadowCompareTeam(r, DOC_A);
    expect(rep.match).toBe(true);
    expect(rep.onlyLegacy).toEqual([]);
    expect(rep.onlyMembership).toEqual([]);
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it('owner NÃO é falsa divergência (está em user_doctor_access ∪ {owner})', async () => {
    const rep = await shadowCompareTeam(req(), DOC_A);
    expect(rep.onlyMembership).not.toContain(OWNER);
  });

  it('user_doctor_access sem membership -> onlyLegacy + log.warn (não corrige)', async () => {
    seed({ user_doctor_access: [{ user_id: CLOSER, doctor_id: DOC_A }, { user_id: 'u-orfao', doctor_id: DOC_A }] });
    const r = req();
    const rep = await shadowCompareTeam(r, DOC_A);
    expect(rep.onlyLegacy).toContain('u-orfao');
    expect(rep.match).toBe(false);
    expect(r.log.warn).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/divergência/));
    // nada foi escrito no banco
    expect(db.tables.memberships).toHaveLength(2);
    expect(db.tables.user_doctor_access).toHaveLength(2);
  });

  it('membership ativa sem user_doctor_access -> onlyMembership (não promove)', async () => {
    seed({
      memberships: [
        { organization_id: ORG_A, user_id: OWNER, role: 'organization_owner', status: 'active' },
        { organization_id: ORG_A, user_id: CLOSER, role: 'closer', status: 'active' },
        { organization_id: ORG_A, user_id: GHOST, role: 'closer', status: 'active' },
      ],
    });
    const rep = await shadowCompareTeam(req(), DOC_A);
    expect(rep.onlyMembership).toEqual([GHOST]);
    expect(db.tables.memberships.find((m) => m.user_id === GHOST).role).toBe('closer'); // inalterado
  });

  it('membership suspensa: aparece em legacyButSuspendedMembership, NÃO é reativada', async () => {
    seed({
      memberships: [
        { organization_id: ORG_A, user_id: OWNER, role: 'organization_owner', status: 'active' },
        { organization_id: ORG_A, user_id: CLOSER, role: 'closer', status: 'suspended' },
      ],
    });
    const rep = await shadowCompareTeam(req(), DOC_A);
    expect(rep.legacyButSuspendedMembership).toContain(CLOSER);
    expect(db.tables.memberships.find((m) => m.user_id === CLOSER).status).toBe('suspended'); // não reativada
  });

  it('idempotente: dois runs produzem o mesmo relatório e nenhum efeito colateral', async () => {
    seed({ user_doctor_access: [{ user_id: CLOSER, doctor_id: DOC_A }, { user_id: 'x', doctor_id: DOC_A }] });
    const a = await shadowCompareTeam(req(), DOC_A);
    const b = await shadowCompareTeam(req(), DOC_A);
    expect(a.onlyLegacy).toEqual(b.onlyLegacy);
    expect(db.tables.memberships).toHaveLength(2);
  });

  it('flag off: shadow-read é no-op (retorna null)', async () => {
    process.env.TENANT_CORE_ENABLED = 'false';
    vi.resetModules();
    const mod = await import('../src/lib/teamShadowRead.js');
    expect(await mod.shadowCompareTeam(req(), DOC_A)).toBeNull();
    process.env.TENANT_CORE_ENABLED = 'true';
  });
});
