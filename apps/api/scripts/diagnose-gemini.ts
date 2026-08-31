#!/usr/bin/env npx tsx
/**
 * ДИАГНОСТИКА ФОРМАТА ЗАПРОСА К GEMINI
 *
 * Зачем: в AI Studio видны 400 BadRequest / 500 / 503 и НОЛЬ output-токенов,
 * то есть ни один вызов не дошёл до ответа. 400 — это НЕ авторизация
 * (та даёт 401/403), а форма тела запроса. Угадывать форму по документации
 * дорого; этот скрипт перебирает кандидатов против ВАШЕГО ключа и печатает
 * ТОЧНЫЙ ответ API по каждому.
 *
 * Запуск:
 *   GEMINI_API_KEY=... npx tsx scripts/diagnose-gemini.ts
 *   GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.7-flash npx tsx scripts/diagnose-gemini.ts
 *   GEMINI_API_KEY=... YT_URL=https://www.youtube.com/watch?v=... npx tsx scripts/diagnose-gemini.ts
 *
 * Ничего не пишет в БД и никуда не деплоится — только сеть к Google и stdout.
 */

const API_KEY = process.env.GEMINI_API_KEY ?? '';
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.7-flash';
const HOST = process.env.GEMINI_HOST ?? 'https://generativelanguage.googleapis.com';
// Короткий заведомо публичный ролик. Замените на свой, если этот недоступен
// в вашем регионе — региональная блокировка тоже даёт ошибку.
const YT_URL = process.env.YT_URL ?? 'https://www.youtube.com/watch?v=9hE5-98ZeCg';

if (!API_KEY) {
  console.error('GEMINI_API_KEY не задан');
  process.exit(1);
}

type Attempt = {
  name: string;
  method: 'POST';
  path: string;
  auth: 'header' | 'query';
  body: unknown;
};

const PROMPT = 'Опиши это видео одним предложением.';

const attempts: Attempt[] = [
  // ── Interactions API (текущий основной интерфейс) ──
  {
    name: 'A1  interactions | header-auth | media→text | background',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'header',
    body: {
      model: MODEL,
      background: true,
      input: [
        { type: 'video', uri: YT_URL },
        { type: 'text', text: PROMPT },
      ],
    },
  },
  {
    name: 'A2  interactions | header-auth | media→text | БЕЗ background',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'header',
    body: {
      model: MODEL,
      input: [
        { type: 'video', uri: YT_URL },
        { type: 'text', text: PROMPT },
      ],
    },
  },
  {
    name: 'A3  interactions | query-auth (?key=) | media→text',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'query',
    body: {
      model: MODEL,
      input: [
        { type: 'video', uri: YT_URL },
        { type: 'text', text: PROMPT },
      ],
    },
  },
  {
    name: 'A4  interactions | text→media (обратный порядок)',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'header',
    body: {
      model: MODEL,
      input: [
        { type: 'text', text: PROMPT },
        { type: 'video', uri: YT_URL },
      ],
    },
  },
  {
    name: 'A5  interactions | с mime_type на YouTube-URL (ожидаем 400 — проверка гипотезы)',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'header',
    body: {
      model: MODEL,
      input: [
        { type: 'video', uri: YT_URL, mime_type: 'video/mp4' },
        { type: 'text', text: PROMPT },
      ],
    },
  },
  {
    name: 'A6  interactions | ТОЛЬКО текст (изолирует: проблема в медиа или во всём запросе)',
    method: 'POST',
    path: '/v1beta/interactions',
    auth: 'header',
    body: { model: MODEL, input: [{ type: 'text', text: 'Ответь одним словом: работает' }] },
  },
  // ── Legacy generateContent (на случай, если ключ/модель не пускают в interactions) ──
  {
    name: 'B1  generateContent (legacy) | header-auth | file_data.file_uri',
    method: 'POST',
    path: `/v1beta/models/${MODEL}:generateContent`,
    auth: 'header',
    body: {
      contents: [
        {
          parts: [
            { file_data: { file_uri: YT_URL } },
            { text: PROMPT },
          ],
        },
      ],
    },
  },
  {
    name: 'B2  generateContent (legacy) | query-auth | file_data.file_uri',
    method: 'POST',
    path: `/v1beta/models/${MODEL}:generateContent`,
    auth: 'query',
    body: {
      contents: [
        {
          parts: [
            { file_data: { file_uri: YT_URL } },
            { text: PROMPT },
          ],
        },
      ],
    },
  },
  {
    name: 'B3  generateContent (legacy) | только текст',
    method: 'POST',
    path: `/v1beta/models/${MODEL}:generateContent`,
    auth: 'query',
    body: { contents: [{ parts: [{ text: 'Ответь одним словом: работает' }] }] },
  },
];

function buildUrl(a: Attempt): string {
  const base = `${HOST}${a.path}`;
  return a.auth === 'query' ? `${base}?key=${encodeURIComponent(API_KEY)}` : base;
}

function buildHeaders(a: Attempt): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (a.auth === 'header') h['x-goog-api-key'] = API_KEY;
  return h;
}

async function run() {
  console.log(`Модель: ${MODEL}`);
  console.log(`Хост:   ${HOST}`);
  console.log(`Видео:  ${YT_URL}`);
  console.log('='.repeat(78));

  const ok: string[] = [];

  for (const a of attempts) {
    process.stdout.write(`\n▶ ${a.name}\n`);
    const started = Date.now();
    try {
      const res = await fetch(buildUrl(a), {
        method: a.method,
        headers: buildHeaders(a),
        body: JSON.stringify(a.body),
      });
      const text = await res.text();
      const ms = Date.now() - started;

      if (res.ok) {
        ok.push(a.name);
        console.log(`  ✅ HTTP ${res.status} за ${ms} мс`);
        // Печатаем только начало — полный ответ на видео может быть большим.
        console.log(`  ${text.slice(0, 900).replace(/\n/g, '\n  ')}`);
      } else {
        console.log(`  ❌ HTTP ${res.status} за ${ms} мс`);
        // ЭТО САМОЕ ВАЖНОЕ МЕСТО СКРИПТА: тело 400-го содержит конкретную
        // причину. Печатаем целиком, не обрезая до бесполезного.
        console.log(`  ${text.slice(0, 2500).replace(/\n/g, '\n  ')}`);
      }
    } catch (err) {
      console.log(`  💥 сетевая ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Пауза, чтобы не словить 429 на free tier и не смазать картину.
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log('\n' + '='.repeat(78));
  if (ok.length === 0) {
    console.log('Ни один вариант не прошёл. Смотрите тела ответов выше — там точная причина.');
    console.log('Если ВЕЗДЕ 400 и даже A6/B3 (только текст) не проходят — проблема не в медиа,');
    console.log('а в ключе, модели или хосте: проверьте имя модели в AI Studio → API Keys.');
  } else {
    console.log('Прошли:');
    ok.forEach((n) => console.log(`  ✅ ${n}`));
    console.log('\nБерите первый прошедший вариант как эталон и приводите GeminiClient к нему.');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
