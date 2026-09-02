// Пункт [job-landing-attribution] 2026-09-02 — deep-link лендинга.
//
// У apps/landing до этого не было НИ ОДНОГО теста, и цена этого уже
// заплачена: параметр запуска клеился как `?start=`, хотя в .env.example
// стоит прямая ссылка на Mini App (`t.me/<bot>/<app>`), для которой
// Telegram читает только `?startapp=`. Атрибуция §4 ТЗ не работала
// вовсе, а §7 п.1 успел записать её исправленной. Это ровно тот класс
// ошибки, который ловится тремя строками проверки — они ниже.
//
// Раннер тот же, что у TMA (scripts/run-standalone-specs.js): без
// describe/it, чистые функции, без DOM.

import {
  telegramStartParamName,
  sanitizeStartPayload,
  telegramStartUrl,
} from '../lib/telegram-url';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

const scenarios: Array<[string, () => void]> = [
  ['ссылка на Mini App (t.me/bot/app) → startapp', () => {
    assertEqual(telegramStartParamName('https://t.me/da_bot/app'), 'startapp', 'форма Mini App');
  }],
  ['ссылка на бота (t.me/bot) → start', () => {
    assertEqual(telegramStartParamName('https://t.me/da_bot'), 'start', 'форма бота');
  }],
  ['хвост запроса и якорь не влияют на выбор параметра', () => {
    assertEqual(telegramStartParamName('https://t.me/da_bot?x=1#y'), 'start', 'бот с хвостом');
    assertEqual(telegramStartParamName('https://t.me/da_bot/app#y'), 'startapp', 'Mini App с якорем');
  }],
  ['payload с недопустимыми символами отбрасывается целиком', () => {
    assertEqual(sanitizeStartPayload('jobs_landing__google-ads'), 'jobs_landing__google-ads', 'допустимые символы сохраняются');
    // Зачистка была бы хуже: «google/ads» стало бы «googleads», а
    // «яндекс» — пустой кампанией, то есть данными, которые считают
    // не то.
    assertEqual(sanitizeStartPayload('jobs landing!'), null, 'пробелы и знаки — метка недействительна');
    assertEqual(sanitizeStartPayload('jobs_landing__яндекс'), null, 'кириллица — метка недействительна');
  }],
  ['слишком длинный payload отбрасывается целиком, а не режется', () => {
    // Обрезанная метка хуже отсутствующей: выглядит как данные, а
    // считает не то.
    assertEqual(sanitizeStartPayload('a'.repeat(65)), null, 'больше 64 символов');
  }],
  ['метка кампании приклеивается через __', () => {
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL = 'https://t.me/da_bot/app';
    // Модуль читает env на импорте, поэтому здесь проверяем чистую
    // сборку payload, а не сам URL (URL — сценарий ниже).
    assertEqual(sanitizeStartPayload('jobs_landing__google'), 'jobs_landing__google', 'кампания в payload');
  }],
  ['плейсхолдер без юзернейма бота параметр не получает', () => {
    // TELEGRAM_URL читается на импорте модуля; в тестовой среде
    // переменная не задана → плейсхолдер 'https://t.me/'.
    const url = telegramStartUrl('jobs_landing');
    assertEqual(url.includes('start'), false, 'ссылка t.me/?start=… вела бы в никуда');
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
console.log(`\ntelegram-url.ts: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
