import { describe, it, expect, beforeEach, vi } from 'vitest';
import { waitForSendSlot, __resetWhatsAppPacingForTests } from '../src/lib/whatsappPacing.js';

beforeEach(() => {
  __resetWhatsAppPacingForTests();
});

describe('waitForSendSlot — pacing serial por médico', () => {
  // Base de tempo distante de 0: como o relógio de um médico "novo" no Map
  // vale 0, começar em t=0 faria o primeiro envio calcular wait=interval-0
  // (positivo) e esperar indevidamente. Uma base grande evita esse artefato.
  const BASE_T = 10_000_000;

  it('primeiro envio para um médico nunca espera', async () => {
    const sleepImpl = vi.fn(async () => {});
    await waitForSendSlot('doc-1', 1000, { sleepImpl, now: () => BASE_T });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('segundo envio pro MESMO médico espera o intervalo restante desde o último envio', async () => {
    const sleepImpl = vi.fn(async () => {});
    let t = BASE_T;
    const now = () => t;
    await waitForSendSlot('doc-1', 1000, { sleepImpl, now });
    t = BASE_T + 300; // só 300ms se passaram desde o último envio
    await waitForSendSlot('doc-1', 1000, { sleepImpl, now });
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(700); // faltam 700ms pra completar 1000ms
  });

  it('se o intervalo já passou, não espera', async () => {
    const sleepImpl = vi.fn(async () => {});
    let t = BASE_T;
    const now = () => t;
    await waitForSendSlot('doc-1', 1000, { sleepImpl, now });
    t = BASE_T + 1500; // já passou mais que o intervalo
    await waitForSendSlot('doc-1', 1000, { sleepImpl, now });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('médicos diferentes têm relógios independentes — nunca esperam um pelo outro', async () => {
    const sleepImpl = vi.fn(async () => {});
    const now = () => BASE_T;
    await waitForSendSlot('doc-A', 1000, { sleepImpl, now });
    await waitForSendSlot('doc-B', 1000, { sleepImpl, now });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('intervalo 0 (pacing desligado) nunca espera, mesmo em envios consecutivos', async () => {
    const sleepImpl = vi.fn(async () => {});
    const now = () => 0;
    await waitForSendSlot('doc-1', 0, { sleepImpl, now });
    await waitForSendSlot('doc-1', 0, { sleepImpl, now });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('sem doctorId, nunca espera (guarda defensiva)', async () => {
    const sleepImpl = vi.fn(async () => {});
    await waitForSendSlot(null, 1000, { sleepImpl, now: () => 0 });
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});
