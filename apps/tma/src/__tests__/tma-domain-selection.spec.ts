// Пункт [one-build-two-products] 2026-10-01 — выключатель доменов
// сборки, проверенный ПОВЕДЕНИЕМ: модуль перечитывается с разным
// значением переменной окружения. Без этого «выключатель есть» означало
// бы только «строка в файле есть».
//
// Написано в стиле standalone-раннера, а не jest: спеку в jest-стиле в
// этом приложении не запускает НИЧЕГО — `npm test` здесь это
// `run-standalone-specs.js`, и он файлы с `describe(` пропускает.
// Поймано на себе: первая версия этой спеки была в jest-стиле и тихо не
// исполнялась, при зелёном прогоне на 427 проверок.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const MODULE_PATH = '../lib/domains/manifests';

function loadWith(value: string | undefined): any {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  const prev = process.env.NEXT_PUBLIC_TMA_DOMAINS;
  if (value === undefined) delete process.env.NEXT_PUBLIC_TMA_DOMAINS;
  else process.env.NEXT_PUBLIC_TMA_DOMAINS = value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(MODULE_PATH);
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_TMA_DOMAINS;
    else process.env.NEXT_PUBLIC_TMA_DOMAINS = prev;
  }
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: переменной нет — все восемь доменов, поведение ровно прежнее', () => {
    const m = loadWith(undefined);
    assert(m.ALL_DOMAIN_IDS.length === 8, `известных доменов не восемь: ${m.ALL_DOMAIN_IDS.length}`);
    assert(Object.keys(m.DOMAIN_MANIFESTS).length === 8, `без переменной показаны не все: ${Object.keys(m.DOMAIN_MANIFESTS)}`);
  }],

  ['пустое значение — тоже все: «задано пустым» это не выбор', () => {
    const m = loadWith('   ');
    assert(Object.keys(m.DOMAIN_MANIFESTS).length === 8, `пустая строка сузила набор: ${Object.keys(m.DOMAIN_MANIFESTS)}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сборка найма отдаёт ровно три домена и ни одного лишнего', () => {
    const m = loadWith('job-search,interview-pool,employer-hiring');
    const got = Object.keys(m.DOMAIN_MANIFESTS).sort().join(',');
    assert(got === 'employer-hiring,interview-pool,job-search', `набор не тот: ${got}`);
    assert(m.DOMAIN_LIST.length === 3, `список доменов не из трёх: ${m.DOMAIN_LIST.length}`);
    assert(m.domainEnabled('job-search') === true, 'найм выключен в сборке найма');
    assert(m.domainEnabled('dtp') === false, 'ДТП показан в сборке найма');
  }],

  ['пробелы вокруг имён не ломают отбор — переменную правят руками', () => {
    const m = loadWith(' job-search , interview-pool ');
    const got = Object.keys(m.DOMAIN_MANIFESTS).sort().join(',');
    assert(got === 'interview-pool,job-search', `пробелы сломали отбор: ${got}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: опечатка ОСТАНАВЛИВАЕТ сборку, а не вырезает экраны молча', () => {
    let message = '';
    try {
      loadWith('job-serach');
    } catch (e) {
      message = (e as Error).message;
    }
    assert(/неизвестные домены: job-serach/.test(message), `опечатка прошла молча: «${message}»`);
    assert(/Известные:/.test(message), `не сказано, какие бывают: «${message}»`);
  }],

  ['список ВСЕХ доменов не зависит от сборки — иначе разбор ссылки перестал бы узнавать домен', () => {
    const m = loadWith('job-search');
    assert(m.ALL_DOMAIN_IDS.length === 8, `полный список сузился вместе со сборкой: ${m.ALL_DOMAIN_IDS.length}`);
    assert(m.ALL_DOMAIN_IDS.includes('dtp'), 'ДТП исчез из полного списка');
    assert(m.domainEnabled('dtp') === false, 'при этом он должен быть выключен в ЭТОЙ сборке');
  }],

  ['ОБРАТНАЯ ПРОБА: отбор смотрит на переменную, а не возвращает один набор всегда', () => {
    const all = loadWith(undefined);
    const narrow = loadWith('health');
    assert(
      Object.keys(all.DOMAIN_MANIFESTS).length !== Object.keys(narrow.DOMAIN_MANIFESTS).length,
      'набор не изменился от переменной — значит отбора нет',
    );
    assert(Object.keys(narrow.DOMAIN_MANIFESTS).join(',') === 'health', `узкий набор не тот: ${Object.keys(narrow.DOMAIN_MANIFESTS)}`);
  }],

  ['ОБРАТНАЯ ПРОБА: переменная читается ЛИТЕРАЛЬНЫМ process.env — иначе сборщик не подставит значение', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'domains', 'manifests.ts'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(
      stripped.includes('process.env.NEXT_PUBLIC_TMA_DOMAINS'),
      'чтение не литеральное: webpack подставляет значение только в текст `process.env.NAME`',
    );
  }],
];

let failed = 0;
for (const [name, fn] of scenarios) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}
if (failed > 0) process.exit(1);
