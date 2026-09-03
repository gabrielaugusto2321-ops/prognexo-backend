import { defineConfig } from 'vitest/config';

// O import de src/server.js puxa toda a árvore de dependências (googleapis é
// grande e frio no Windows leva dezenas de segundos). Damos folga aos hooks e
// testes para o beforeAll que sobe o app não estourar timeout.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
