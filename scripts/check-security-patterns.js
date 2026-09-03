// Lint de segurança — falha o build se aparecer um anti-padrão conhecido.
// Roda em `npm run lint`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = [];

// `src/scripts/` são utilitários de linha de comando — console.* é saída legítima.
const SKIP_DIRS = new Set(['scripts']);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (full.endsWith('.js')) {
      files.push(full);
    }
  }
}
walk(root);

const forbidden = [
  { re: /\.(insert|update)\(\s*req\.body/g, msg: 'insert/update com req.body cru (mass assignment)' },
  { re: /res\.status\(\d{3}\)\.json\(\s*\{\s*error:\s*(?:`[^`]*\$\{)?[A-Za-z_]*[Ee]rr(?:or)?\b[^}]*\.message/g, msg: 'mensagem de erro interna vazando na resposta' },
  { re: /req\.originalUrl/g, msg: 'req.originalUrl (loga query string / segredos)' },
  { re: /console\.(log|error|warn|info|debug)\s*\(/g, msg: 'console.* — usar o logger com redação' },
];

const hits = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const { re, msg } of forbidden) {
    re.lastIndex = 0;
    if (re.test(src)) hits.push(`${path.relative(root, file)}: ${msg}`);
  }
}

if (hits.length) {
  console.error('Security pattern lint FAILED:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`Security pattern lint passed (${files.length} files).`);
