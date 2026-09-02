// Пункт [deep-links] / [job-landing-attribution] 2026-09-02.
//
// Найдено аудитом: во всём монорепо не было ни одного чтения
// start_param. Следствия: экран принятия переданного профиля кандидата
// был физически недостижим (ссылка приводила на главную), а метка
// посадочной /jobs не доезжала до intake-сессии — атрибуция §4 ТЗ
// job-landing не работала.
//
// Самое опасное место разбора — `__`: у посадочных это разделитель
// кампании, а у токенов приглашений (base64url) те же символы могут
// быть частью самого токена. Ошибка здесь режет токен и ломает
// приглашение, а выглядит как «ссылка недействительна».
import { parseStartPayload, startParamRoute } from '../lib/start-param';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

const scenarios: Array<[string, () => void]> = [
  ['посадочная кандидата распознаётся', () => {
    const a = parseStartPayload('jobs_landing');
    assertEqual(a?.source, 'jobs_landing', 'источник');
    assertEqual(a?.audience, 'candidate', 'аудитория');
    assertEqual(a?.campaign, null, 'кампании нет');
  }],
  ['посадочная агентства распознаётся', () => {
    assertEqual(parseStartPayload('recruiting_landing')?.audience, 'agency', 'аудитория');
  }],
  ['кампания отделяется от источника', () => {
    const a = parseStartPayload('jobs_landing__google');
    assertEqual(a?.source, 'jobs_landing', 'источник');
    assertEqual(a?.campaign, 'google', 'кампания');
  }],
  ['КЛЮЧЕВОЙ ТЕСТ: токен приглашения с «__» не режется', () => {
    // base64url-токен вполне может содержать «__»; делить его по
    // разделителю кампании — значит выдать «ссылка недействительна» на
    // рабочем приглашении.
    const token = 'aB__cD-ef';
    const a = parseStartPayload(`share_${token}`);
    assertEqual(a?.raw, `share_${token}`, 'параметр сохранён целиком');
    assertEqual(a?.campaign, null, 'у токена нет кампании');
    assertEqual(startParamRoute(a), `/candidate-shares/${token}`, 'маршрут с целым токеном');
  }],
  ['пакетная передача пула ведёт на тот же экран', () => {
    assertEqual(startParamRoute(parseStartPayload('team_share_xyz')), '/candidate-shares/xyz', 'маршрут');
  }],
  ['приглашение в команду и в инвест-группу ведут в свои домены', () => {
    assertEqual(startParamRoute(parseStartPayload('team_abc')), '/domains/interview-pool?invite=abc', 'команда');
    assertEqual(startParamRoute(parseStartPayload('investment_group_abc')), '/domains/investment?invite=abc', 'инвест-группа');
  }],
  ['метка посадочной ведёт в квиз, а не в отдельный путь', () => {
    // ТЗ job-landing §4: отдельного onboarding-пути не нужно, квиз
    // классифицирует сценарий сам.
    assertEqual(startParamRoute(parseStartPayload('jobs_landing__google')), '/intake', 'маршрут');
  }],
  ['мусор и пустое — null, а не догадка', () => {
    assertEqual(parseStartPayload(''), null, 'пусто');
    assertEqual(parseStartPayload('   '), null, 'пробелы');
    assertEqual(parseStartPayload('плохой параметр!'), null, 'недопустимые символы');
    assertEqual(parseStartPayload('a'.repeat(65)), null, 'длиннее 64');
    assertEqual(startParamRoute(null), null, 'нет параметра — нет перехода');
  }],
  ['неизвестный параметр не даёт перехода', () => {
    assertEqual(startParamRoute(parseStartPayload('promo_2027')), null, 'ничего не выдумываем');
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
console.log(`\nstart-param.ts: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
