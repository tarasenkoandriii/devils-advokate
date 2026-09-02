// Инцидент деплоя 2026-09-02: NEXT_PUBLIC_SITE_URL без протокола ронял
// prerender всех страниц (`new URL` → Invalid URL). Проверяем нормализацию
// и то, что невалидное значение даёт запасное, а не исключение.
import { normalizeSiteUrl, FALLBACK_SITE_URL } from '../lib/site-url';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ: хост без протокола (как было задано на Vercel) → https:// добавляется, сборка не падает', () => {
    assertEqual(normalizeSiteUrl('devils-advocate.example.com'), 'https://devils-advocate.example.com', 'протокол добавлен');
    assertEqual(new URL(normalizeSiteUrl('devils-advocate.example.com')).host, 'devils-advocate.example.com', 'результат валиден для new URL');
  }],
  ['хвостовой слэш и пробелы снимаются', () => {
    assertEqual(normalizeSiteUrl('  https://site.example/  '), 'https://site.example', 'обрезка');
    assertEqual(normalizeSiteUrl('https://site.example/base/'), 'https://site.example/base', 'путь сохранён без слэша');
  }],
  ['пусто / мусор / чужой протокол → запасное значение, не исключение', () => {
    assertEqual(normalizeSiteUrl(undefined), FALLBACK_SITE_URL, 'не задано');
    assertEqual(normalizeSiteUrl(''), FALLBACK_SITE_URL, 'пустая строка');
    assertEqual(normalizeSiteUrl('exa mple.com'), FALLBACK_SITE_URL, 'мусор (пробел в хосте — Invalid URL)');
    assertEqual(normalizeSiteUrl('ftp://site.example'), FALLBACK_SITE_URL, 'не http(s)');
  }],
];

let failed = 0;
for (const [name, fn] of scenarios) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n${(err as Error).message}`);
  }
}
console.log(`site-url: ${scenarios.length - failed}/${scenarios.length} passed`);
if (failed > 0) process.exit(1);
