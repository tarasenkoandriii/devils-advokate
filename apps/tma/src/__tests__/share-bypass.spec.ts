// Сверка 2026-09-05 — дверь наружу мимо проверки.
//
// НАЙДЕННОЕ. MVP-фича 12 (Safe Share) закрывала конкретную дыру, и в
// коде она названа своими словами: `ShareButton` «шарил текст
// аргументов напрямую в Telegram, вообще не проходя через content scan
// — настоящая дыра в приватности, не гипотетическая». Дыру закрыли:
// preflight → превью «вот что увидит получатель» → подтверждение.
//
// А в общем доменном компоненте `TextDocument` стояло:
//
//   onClick={() => navigator.clipboard?.writeText(data.text)}
//   onClick={() => shareViaTelegram(data.text)}
//
// Та же дыра, заново открытая в другом компоненте — и не где угодно, а
// на двух самых тяжёлых документах продукта: проект соглашения о
// возмещении после ДТП и проект соглашения при разводе. Имена, адреса,
// телефоны, номера машин, деньги, дети. Правило было, просто не везде.
//
// КОПИРОВАНИЕ — ТОЖЕ ДВЕРЬ, и это не педантизм: пока «Скопировать»
// работает в обход, оно и есть обход «Отправить», а проверка тогда не
// защищает ни от чего.
//
// ЧЕГО СВЕРКА НЕ ДЕЛАЕТ. Не добавляет кнопку «отправить как есть».
// Она вернула бы ровно ту дверь, ради закрытия которой всё написано.
// Документ может потерять адрес или телефон — это видно в превью ДО
// отправки, и рядом сказано, что делать: вписать нужное самому.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь: прежние вызовы процитированы в шапке этого файла
 * и в комментарии самого компонента — проверка на текст поймала бы их. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function screens(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) out.push(full);
    }
  })(SRC);
  return out;
}

/** Файл, отправляющий текст наружу, обязан звать preflight. Проверка
 * по дереву, а не по списку файлов: пятый компонент с прямой отправкой
 * должен уронить её, а не повторить изъян тихо. */
function outboundCalls(src: string): string[] {
  return [...src.matchAll(/(?:shareViaTelegram|clipboard\??\.writeText)\(\s*([^),]*)/g)].map((m) => m[1].trim());
}

/** Единственное исключение, и оно НАЗВАНО, а не подразумевается: наружу
 * может уходить без проверки то, что не является текстом человека —
 * выданная продуктом ссылка-приглашение. Сканировать в токене нечего.
 * Правило смотрит на ВЫРАЖЕНИЕ в вызове, а не на имя файла: тот же
 * компонент, отправляющий что-то ещё, снова становится нарушителем. */
const LINK_ONLY = /^(link|url|href|shareUrl|inviteLink)$/;

function outboundOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of screens()) {
    const src = code(file);
    const calls = outboundCalls(src).filter((arg) => !LINK_ONLY.test(arg));
    if (calls.length === 0) continue;
    if (!/safeSharePreflight\(/.test(src)) offenders.push(`${file.slice(SRC.length + 1)} (${calls.join(', ')})`);
  }
  return offenders;
}

/** Тело функции с учётом вложенных скобок. `indexOf` по соседнему коду
 * не годится: в этом файле десяток компонентов, и каждый начинается с
 * одинакового `if (error) return` — первая версия проверки резала срез
 * по чужому вхождению и падала на верном коде. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  let depth = 1;
  let j = open + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return src.slice(open + 1, j - 1);
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: ни один экран не отправляет текст наружу мимо проверки', () => {
    const offenders = outboundOffenders();
    assert(offenders.length === 0, `отправка наружу без preflight: ${offenders.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: наружу уходит именно проверенный текст, а не исходный', () => {
    // Само по себе наличие preflight ничего не значит: можно вызвать
    // проверку и отправить оригинал. Проверяется, что в отправку идёт
    // результат проверки.
    const doc = code(join(SRC, 'components/domains/shared/ConsultationPipeline.tsx'));
    assert(/shareViaTelegram\(preview\.text\)/.test(doc), 'в Telegram снова уходит исходный текст документа');
    assert(/writeText\(preview\.text\)/.test(doc), 'в буфер обмена снова попадает исходный текст документа');
    assert(!/shareViaTelegram\(data\.text\)/.test(doc), 'прямая отправка исходного текста вернулась');
    assert(!/writeText\(data\.text\)/.test(doc), 'прямое копирование исходного текста вернулось');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: копирование проходит ту же дверь, что и отправка', () => {
    // Иначе «Скопировать» становится тривиальным обходом «Отправить», и
    // проверка перестаёт защищать хоть от чего-нибудь.
    const doc = code(join(SRC, 'components/domains/shared/ConsultationPipeline.tsx'));
    assert(/startShare\('copy'/.test(doc), 'копирование снова идёт мимо проверки');
    assert(/startShare\('send'/.test(doc), 'отправка снова идёт мимо проверки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отправка не происходит без подтверждения человеком', () => {
    const doc = code(join(SRC, 'components/domains/shared/ConsultationPipeline.tsx'));
    // Отправка стоит ТОЛЬКО внутри подтверждения, а не в обработчике
    // кнопки: превью, из которого нельзя отказаться, — не превью.
    const confirmBody = functionBody(doc, 'async function confirmShare');
    assert(confirmBody.length > 0, 'подтверждения отправки больше нет');
    assert(/shareViaTelegram\(/.test(confirmBody), 'отправка вынесена из подтверждения');
    assert(/safeShareConfirm\(preview\.actionId\)/.test(confirmBody), 'подтверждение не записывается в журнал Safe Share');
    assert(/Отмена/.test(doc), 'из превью нельзя отказаться');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сказано, что именно скрыто и что с этим делать', () => {
    // Число без объяснения превращает превью в формальность: человек
    // отправляет документ, из которого молча выпал адрес.
    const doc = code(join(SRC, 'components/domains/shared/ConsultationPipeline.tsx'));
    assert(/Обнаружено и скрыто чувствительных данных/.test(doc), 'не сказано, сколько скрыто');
    assert(/впишите это сами/.test(doc), 'не сказано, что делать, если скрытое нужно получателю');
    // И заголовок превью честно называет назначение: буфер обмена — не
    // «получатель».
    assert(/Вот что попадёт в буфер обмена/.test(doc), 'превью копирования выдаёт себя за отправку получателю');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отклонённый проверкой документ не уходит молча', () => {
    const doc = code(join(SRC, 'components/domains/shared/ConsultationPipeline.tsx'));
    assert(/blocked &&/.test(doc), 'отклонение проверкой не показывается');
    assert(/отправка не состоялась/.test(doc), 'не сказано, что отправки не было');
  }],

  ['ИЗМЕРЕНИЕ: сколько в продукте дверей наружу и все ли через проверку', () => {
    // Точка отсчёта для следующей сверки. Список зафиксирован, чтобы
    // пятая дверь была видна, а не растворилась среди прочих.
    const doors = screens().filter((f) => /shareViaTelegram\(|clipboard\?\.writeText\(|clipboard\.writeText\(/.test(code(f)));
    const names = doors.map((f) => f.slice(SRC.length + 1)).sort();
    assert(names.length === 5, `дверей наружу должно быть 5, найдено ${names.length}: ${names.join(', ')}`);
    // Пятая — копирование ссылки-приглашения в пуле собеседований: это
    // не текст человека, а выданный продуктом токен, и сканировать в
    // нём нечего. Названа здесь прямо, чтобы исключение было решением,
    // а не случайностью.
    assert(names.includes('components/domains/InterviewPoolWorkspace.tsx'),
      'состав дверей изменился — пересмотрите исключение для ссылки-приглашения');
    const invite = code(join(SRC, 'components/domains/InterviewPoolWorkspace.tsx'));
    assert(/writeText\(link\)/.test(invite), 'в пуле собеседований копируется уже не ссылка — исключение больше не действует');
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nshare-bypass: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
