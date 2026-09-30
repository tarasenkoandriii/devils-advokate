// Пункт [cut-off-was-called-malformed] + [green-deploy-pointed-at-localhost]
// 2026-09-30 — поведение двух мест, которые оба молчали о деплое.
//
// ПЕРВОЕ. Тело, не разобравшееся как JSON, давало одну фразу на все
// случаи: «Сервер вернул некорректный ответ». Самый частый случай при
// этом — не некорректный ответ, а ОТСУТСТВИЕ ответа: платформа обрывает
// функцию по времени и отдаёт свою страницу 504. Человек читал
// утверждение о сервере, которое не было правдой, и — из-за кириллицы в
// этой фразе — ветка «сбой на нашей стороне» для 5xx не достигалась
// никогда. Проверяется РАЗЛИЧИЕ трёх исходов, а не наличие слов.
//
// ВТОРОЕ. Адрес API брался как `process.env.NEXT_PUBLIC_API_BASE_URL ??
// 'http://localhost:3000'` — восемь раз в этом приложении. Переменная
// читается на СБОРКЕ, значит без неё в бандл уезжает localhost, деплой
// зелёный, а каждый запрос уходит на localhost браузера человека.
// Проверяется, что на платформе это отказ сборки, а не подстановка.

process.env.NEXT_PUBLIC_DEV_USER_ID = 'test-user-1';

import { readFileSync } from 'fs';
import { join } from 'path';
import { nonJsonMessage, humanizeApiError, ApiRequestError } from '../lib/api';
import { resolveApiBaseUrl, LOCAL_API_BASE_URL } from '../lib/api-base-url';

function assertTrue(cond: boolean, message: string) {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`FAIL: ${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
}

function assertThrows(fn: () => unknown, message: string): Error {
  try {
    fn();
  } catch (err: any) {
    return err as Error;
  }
  throw new Error(`FAIL: ${message} — не бросило`);
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  [
    'КЛЮЧЕВОЙ: обрыв по времени и неразобранный ответ — разные тексты',
    () => {
      const cutOff = nonJsonMessage(504);
      const notParsed = nonJsonMessage(500);
      assertTrue(cutOff !== notParsed, 'обрыв по времени и неразобранный ответ должны звучать по-разному');
      // Ни одно из двух не утверждает, что сервер что-то ВЕРНУЛ: при
      // обрыве он не возвращал ничего, и прежняя фраза об этом врала.
      for (const text of [cutOff, notParsed]) {
        assertTrue(!text.includes('Сервер вернул'), `текст не должен утверждать, что сервер что-то вернул: ${text}`);
      }
    },
  ],
  [
    'все статусы обрыва дают текст про прерывание по времени',
    () => {
      for (const status of [408, 502, 503, 504, 524]) {
        const text = nonJsonMessage(status);
        assertTrue(text.includes('прерван'), `статус ${status} должен объясняться прерыванием, получено: ${text}`);
      }
    },
  ],
  [
    'текст обрыва предупреждает о израсходованном суточном лимите',
    () => {
      // Расход отмечается ДО платного шага, поэтому оборванная попытка
      // потолок уже израсходовала. Не сказать этого — отправить человека
      // тратить второй раз.
      assertTrue(nonJsonMessage(504).includes('лимит'), 'текст обрыва должен называть израсходованный лимит');
    },
  ],
  [
    'обратная проба: статус, не относящийся к обрыву, объясняется по-своему',
    () => {
      // 404 с неразобранным телом — не обрыв: подставляется человеческий
      // текст этого статуса, а не рассказ про время.
      const text = nonJsonMessage(404);
      assertTrue(!text.includes('прерван'), `404 не должен объясняться прерыванием: ${text}`);
      assertTrue(text.length > 10, '404 должен получить осмысленный текст');
    },
  ],
  [
    'ApiRequestError с текстом обрыва доходит до человека дословно',
    () => {
      const err = new ApiRequestError(nonJsonMessage(504), 504);
      assertEqual(err.message, nonJsonMessage(504), 'текст не должен подменяться общей фразой про 5xx');
      assertEqual(humanizeApiError(nonJsonMessage(504), 504), nonJsonMessage(504), 'humanizeApiError возвращает русский текст как есть');
    },
  ],
  [
    'КЛЮЧЕВОЙ: на платформе отсутствие адреса API — отказ, а не localhost',
    () => {
      const err = assertThrows(() => resolveApiBaseUrl(undefined, true), 'сборка на платформе без адреса');
      assertTrue(err.message.includes('NEXT_PUBLIC_API_BASE_URL'), 'в отказе должно быть названо имя переменной');
      // Пустая строка — то же самое, что отсутствие: переменная,
      // созданная в панели и оставленная пустой, встречается чаще.
      assertThrows(() => resolveApiBaseUrl('  ', true), 'пустое значение на платформе');
    },
  ],
  [
    'КЛЮЧЕВОЙ: значение берётся из статической ссылки process.env.ИМЯ',
    () => {
      // Первая версия читала окружение через параметр-объект, и сборщик
      // такое подставить не может: на сервере работало, в браузере
      // значение снова было undefined и адрес снова падал на localhost.
      // Сборка при этом зеленела. Здесь проверяется ТЕКСТ источника —
      // именно его и подставляет сборщик.
      const raw = readFileSync(join(process.cwd(), 'src', 'lib', 'api-base-url.ts'), 'utf8');
      // КОММЕНТАРИИ ВЫБРАСЫВАЮТСЯ. Первая версия этой самой проверки
      // покраснела на объяснении, в котором ПРОЦИТИРОВАНО прежнее,
      // неверное обращение `env.NEXT_PUBLIC_…` — то есть наказала за
      // рассказ о дефекте. Девятый случай этой ловушки за сессию.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      assertTrue(
        src.includes('rawValue: string | undefined = process.env.NEXT_PUBLIC_API_BASE_URL'),
        'значение по умолчанию обязано быть статической ссылкой process.env.NEXT_PUBLIC_API_BASE_URL',
      );
      assertTrue(!/[^.]\benv\.NEXT_PUBLIC_API_BASE_URL\b/.test(src), 'чтение через переменную сборщик не подставит');
      assertTrue(!/[^.]\benv\.VERCEL\b/.test(src), 'то же для признака платформы');
      // И проба самой чистки: цитата в комментарии не должна считаться кодом.
      assertTrue(raw.includes('env.NEXT_PUBLIC_API_BASE_URL'), 'в объяснении прежнее обращение процитировано');
    },
  ],
  [
    'обратная проба: вне платформы дефолт разработки остаётся',
    () => {
      assertEqual(resolveApiBaseUrl(undefined, false), LOCAL_API_BASE_URL, 'локально дефолт уместен');
      assertEqual(resolveApiBaseUrl('', false), LOCAL_API_BASE_URL, 'пустое значение локально — тот же дефолт');
    },
  ],
  [
    'хвостовой слэш снимается один раз в одном месте',
    () => {
      assertEqual(
        resolveApiBaseUrl('https://api.example.com/', false),
        'https://api.example.com',
        'иначе склейка даёт //path и отказ выглядит как «объекта нет»',
      );
      assertEqual(
        resolveApiBaseUrl('https://api.example.com///', false),
        'https://api.example.com',
        'несколько слэшей тоже',
      );
    },
  ],
];

async function run() {
  const results: Array<{ name: string; error?: string }> = [];
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }
  const failed = results.filter((r) => r.error);
  console.log(`\ncut-off-was-called-malformed: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
