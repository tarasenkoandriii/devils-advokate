#!/usr/bin/env node
// Запускает spec-файлы «собственного раннера» (без describe()/it(), с
// собственным run() и process.exit) через ts-node — jest их запускать
// не умеет («Your test suite must contain at least one test», а
// process.exit() внутри jest ломает воркер). Найдено аудитом: `npm test`
// (= jest) до этого фактически не запускал 63 из 117 backend-спеков.
//
// Использование: node scripts/run-standalone-specs.js <dir-with-specs> [--type-check]
//   без --type-check — ts-node --transpile-only (быстро, как раньше вручную);
//   с   --type-check — полный ts-node, типы проверяются (медленнее, строже).
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = resolve(process.argv[2] || 'src/__tests__');
const typeCheck = process.argv.includes('--type-check');
const extraTsNodeArgs = process.argv.includes('--tma')
  ? ['--compiler-options', JSON.stringify({ module: 'commonjs', moduleResolution: 'node', jsx: 'react' })]
  : [];

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => join(dir, f))
  // jest-стиль (describe/it) — отдаётся jest, здесь пропускается
  .filter((f) => !/^\s*describe\(/m.test(readFileSync(f, 'utf8')));

let failedFiles = 0;
let passed = 0;
let failed = 0;
for (const file of files) {
  const args = [...(typeCheck ? [] : ['--transpile-only']), ...extraTsNodeArgs, file];
  const res = spawnSync(require.resolve('ts-node/dist/bin.js'), args, { encoding: 'utf8', env: process.env });
  const out = (res.stdout || '') + (res.stderr || '');
  const ok = (out.match(/^✓/gm) || []).length;
  const bad = (out.match(/^✗/gm) || []).length;
  passed += ok;
  failed += bad;
  if (res.status !== 0 || bad > 0) {
    failedFiles += 1;
    console.log(`\n✗ ${file}\n${out}`);
  } else {
    console.log(`✓ ${file} (${ok})`);
  }
}
console.log(`\nstandalone specs: ${files.length} files, ${passed} passed, ${failed} failed, ${failedFiles} file(s) with errors`);
process.exit(failedFiles > 0 ? 1 : 0);
