import { describe, it, expect, vi, beforeEach } from 'vitest';

// A flag é lida do `env` validado no import — fixa ANTES de importar o módulo.
process.env.TENANT_SHADOW_READ_ENABLED = 'true';

// getScopedDoctorIds é mockado para simular o escopo LEGADO.
const legacy = { ids: [] };
vi.mock('../src/middleware/auth.js', () => ({
  getScopedDoctorIds: vi.fn(async () => legacy.ids),
}));

const { shadowCompareScope, getShadowMetrics, __resetShadowMetricsForTests } = await import('../src/lib/tenantShadowRead.js');

function req(tenant) {
  return { user: { id: 'u1', role: 'closer' }, tenant: { enabled: true, ...tenant }, log: { warn() {}, error() {} } };
}

describe('tenant shadow-read', () => {
  beforeEach(() => {
    __resetShadowMetricsForTests();
    legacy.ids = [];
  });

  it('sem req.tenant.enabled: não compara nada', async () => {
    legacy.ids = ['dLEGACY'];
    const r = { user: { id: 'u1' }, tenant: { enabled: false }, log: { warn() {}, error() {} } };
    const out = await shadowCompareScope(r, ['dNEW']);
    expect(out).toEqual(['dNEW']);
    expect(getShadowMetrics().comparisons).toBe(0);
  });

  it('flag off (env): não compara nada', async () => {
    vi.resetModules();
    process.env.TENANT_SHADOW_READ_ENABLED = 'false';
    const m = await import('../src/lib/tenantShadowRead.js');
    legacy.ids = ['dLEGACY'];
    await m.shadowCompareScope(req({ doctorId: 'dNEW', organizationId: 'o1' }), ['dNEW']);
    expect(m.getShadowMetrics().comparisons).toBe(0);
    process.env.TENANT_SHADOW_READ_ENABLED = 'true';
  });

  it('escopos iguais: comparação sem divergência', async () => {
    legacy.ids = ['dA'];
    await shadowCompareScope(req({ doctorId: 'dA', organizationId: 'o1' }), ['dA']);
    const m = getShadowMetrics();
    expect(m.comparisons).toBe(1);
    expect(m.divergences).toBe(0);
  });

  it('doctor só no legado (membership revogada) -> onlyLegacy', async () => {
    legacy.ids = ['dA', 'dB'];
    await shadowCompareScope(req({ doctorId: 'dA', organizationId: 'o1' }), ['dA']);
    const m = getShadowMetrics();
    expect(m.onlyLegacy).toBe(1);
    expect(m.membershipMismatch).toBe(1);
    expect(m.divergences).toBe(1);
  });

  it('doctor só no contexto novo -> onlyOrganization', async () => {
    legacy.ids = [];
    await shadowCompareScope(req({ doctorId: 'dA', organizationId: 'o1' }), ['dA']);
    expect(getShadowMetrics().onlyOrganization).toBe(1);
  });

  it('contexto novo vazio + legado com algo + org selecionada -> missingMap', async () => {
    legacy.ids = ['dA'];
    await shadowCompareScope(req({ doctorId: null, organizationId: 'o1' }), []);
    const m = getShadowMetrics();
    expect(m.missingMap).toBe(1);
    expect(m.onlyLegacy).toBe(1);
  });

  it('um lado irrestrito (null), o outro não -> membershipMismatch', async () => {
    legacy.ids = null; // legado vê tudo (admin legado)
    await shadowCompareScope(req({ doctorId: 'dA', organizationId: 'o1', isPlatformAdmin: false }), ['dA']);
    const m = getShadowMetrics();
    expect(m.membershipMismatch).toBe(1);
    expect(m.divergences).toBe(1);
  });

  it('ambos irrestritos -> sem divergência', async () => {
    legacy.ids = null;
    await shadowCompareScope(req({ isPlatformAdmin: true, doctorId: null }), null);
    expect(getShadowMetrics().divergences).toBe(0);
  });

  it('X-Unit-Id fora das unidades da membership -> unitMismatch', async () => {
    legacy.ids = ['dA', 'dB'];
    await shadowCompareScope(
      req({ doctorId: 'dA', organizationId: 'o1', unitId: 'uX', unitIds: ['u1', 'u2'] }),
      ['dA'],
    );
    expect(getShadowMetrics().unitMismatch).toBe(1);
  });

  it('nunca altera a decisão de acesso (retorna o escopo novo intacto)', async () => {
    legacy.ids = ['dLEGACY-EXTRA'];
    const out = await shadowCompareScope(req({ doctorId: 'dNEW', organizationId: 'o1' }), ['dNEW']);
    expect(out).toEqual(['dNEW']);
  });

  it('erro no legado não quebra o request', async () => {
    const auth = await import('../src/middleware/auth.js');
    auth.getScopedDoctorIds.mockRejectedValueOnce(new Error('boom'));
    const out = await shadowCompareScope(req({ doctorId: 'dNEW', organizationId: 'o1' }), ['dNEW']);
    expect(out).toEqual(['dNEW']);
  });
});
