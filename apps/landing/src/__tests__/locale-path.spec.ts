// Аудит 2026-09-02 (job-landing) — переключатель языка.
import { withLocale } from '../lib/locale-path';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

const scenarios: Array<[string, () => void]> = [
  ['смена языка сохраняет страницу: /ru/jobs → /uk/jobs', () => {
    assertEqual(withLocale('/ru/jobs', 'uk'), '/uk/jobs', 'страница не теряется');
  }],
  ['корень локали: /ru → /en', () => {
    assertEqual(withLocale('/ru', 'en'), '/en', 'корень');
    assertEqual(withLocale(null, 'en'), '/en', 'нет пути');
  }],
  ['КЛЮЧЕВОЙ: utm-параметры рекламной ссылки переживают смену языка', () => {
    assertEqual(
      withLocale('/ru/jobs', 'uk', '?utm_source=linkedin&utm_campaign=q3'),
      '/uk/jobs?utm_source=linkedin&utm_campaign=q3',
      'query сохранён',
    );
    assertEqual(withLocale('/ru/jobs', 'uk', 'utm_source=x'), '/uk/jobs?utm_source=x', 'без ведущего ? тоже');
    assertEqual(withLocale('/ru/jobs', 'uk', ''), '/uk/jobs', 'пустой query — без ?');
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
if (failed > 0) {
  console.log(`locale-path: ${scenarios.length - failed}/${scenarios.length} passed`);
  process.exit(1);
}
console.log(`locale-path: ${scenarios.length}/${scenarios.length} passed`);
