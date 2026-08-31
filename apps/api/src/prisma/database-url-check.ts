// ПОВТОРНЫЙ АУДИТ 2026-08-31 — диагностика строки подключения.
//
// Повод: на проде первый же запрос, дошедший до базы, упал с
//
//   PrismaClientInitializationError: The provided database string is
//   invalid. Error parsing connection string: invalid port number in
//   database URL.
//
// Сообщение Prisma называет симптом (порт), но не причину, а причин у
// этого симптома ровно две, и обе — про то, КАК значение попало в
// окружение, а не про сам порт:
//
//  1. Значение вставили в переменную окружения вместе с кавычками.
//     В файле .env кавычки — часть синтаксиса и снимаются парсером; в
//     UI Vercel/Docker/CI никакого парсера нет, и кавычка становится
//     обычным символом строки. Тогда «порт» получается вида
//     `6543/postgres?pgbouncer=true"` — отсюда и жалоба на порт.
//
//  2. В пароле есть спецсимвол без percent-encoding — чаще всего `@`.
//     Разделителем userinfo и хоста служит `@`, поэтому пароль
//     `S8p@ss` разрезает URL не там, и «портом» оказывается кусок
//     пароля или хоста. Supabase генерирует пароли со спецсимволами,
//     так что случай не экзотический.
//
// Эта проверка выполняется один раз при старте и ПИШЕТ ТОЛЬКО ДИАГНОЗ.
// Ни строки подключения, ни пароля, ни его длины в логах не появляется:
// логи Vercel видит любой участник проекта, а пароль от боевой базы —
// не та вещь, которую стоит туда класть ради удобства отладки.

export interface DatabaseUrlProblem {
  /** Короткий машинный код — для тестов и грепа по логам. */
  code:
    | 'missing'
    | 'name-included'
    | 'quoted'
    | 'whitespace'
    | 'bad-protocol'
    | 'unencoded-at'
    | 'unparseable'
    | 'invalid-port';
  /** Человеческое объяснение с конкретным действием. */
  message: string;
}

const ALLOWED_PROTOCOLS = ['postgres:', 'postgresql:'];

export function diagnoseDatabaseUrl(raw: string | undefined): DatabaseUrlProblem[] {
  const problems: DatabaseUrlProblem[] = [];

  if (!raw || !raw.trim()) {
    return [{ code: 'missing', message: 'DATABASE_URL не задан — Prisma не сможет подключиться ни к какой базе.' }];
  }

  // Третий частый случай (повторный аудит 2026-08-31): в поле значения
  // вставили СТРОКУ ЦЕЛИКОМ из .env — вместе с именем переменной и
  // знаком равенства. Для Vercel это просто значение, начинающееся с
  // «DATABASE_URL=», и дальше всё разбирается не туда.
  if (/^[A-Z_][A-Z0-9_]*\s*=/.test(raw.trim())) {
    problems.push({
      code: 'name-included',
      message:
        'В значение DATABASE_URL попало имя переменной («DATABASE_URL=…»). В UI Vercel/Docker в поле значения кладётся ' +
        'только сама строка подключения, начиная с postgresql://',
    });
  }

  if (/^["']|["']$/.test(raw)) {
    problems.push({
      code: 'quoted',
      message:
        'DATABASE_URL обёрнут в кавычки. В файле .env это нормально, но в переменной окружения (Vercel, Docker, CI) ' +
        'кавычки становятся частью значения — и порт превращается в «6543/postgres?…"». Уберите кавычки из значения.',
    });
  }

  if (/\s/.test(raw)) {
    problems.push({
      code: 'whitespace',
      message:
        'В DATABASE_URL есть пробел или перевод строки — чаще всего он приезжает вместе со скопированным значением. Уберите.',
    });
  }

  // Пароль с незакодированным «@»: считаем «@» в части до последнего
  // из них. Ровно один «@» — норма (разделитель userinfo/host).
  const atCount = (raw.match(/@/g) ?? []).length;
  if (atCount > 1) {
    problems.push({
      code: 'unencoded-at',
      message:
        'В DATABASE_URL больше одного символа «@» — почти наверняка он есть в пароле и не закодирован. ' +
        'Замените «@» в пароле на %40 (и другие спецсимволы: «/» → %2F, «:» → %3A, «?» → %3F, «#» → %23, «%» → %25).',
    });
  }

  const cleaned = raw.replace(/^["']|["']$/g, '').trim();
  let url: URL | null = null;
  try {
    url = new URL(cleaned);
  } catch {
    problems.push({
      code: 'unparseable',
      message: 'DATABASE_URL не разбирается как URL. Ожидаемый вид: postgresql://ПОЛЬЗОВАТЕЛЬ:ПАРОЛЬ@ХОСТ:ПОРТ/БАЗА',
    });
    return problems;
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    problems.push({
      code: 'bad-protocol',
      message: `Протокол «${url.protocol}» не поддерживается Prisma для Postgres — ожидается postgresql:// или postgres://.`,
    });
  }

  if (url.port && !/^\d+$/.test(url.port)) {
    problems.push({
      code: 'invalid-port',
      message: `Порт «${url.port}» не число. Именно на это жалуется Prisma сообщением «invalid port number in database URL».`,
    });
  }

  return problems;
}

/** Отдельно от диагностики: несогласованность пулера — не ошибка
 * синтаксиса, а конфигурационная ловушка Supabase. Порт 6543 (pgbouncer)
 * требует `?pgbouncer=true`, иначе Prisma будет использовать
 * prepared statements, которых transaction-режим pgbouncer не
 * поддерживает, и запросы начнут падать не при старте, а «иногда». */
export function diagnosePoolerMismatch(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^["']|["']$/g, '').trim();
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null; // синтаксис разберёт diagnoseDatabaseUrl()
  }
  const hasPgbouncerFlag = url.searchParams.get('pgbouncer') === 'true';

  if (url.port === '6543' && !hasPgbouncerFlag) {
    return 'DATABASE_URL указывает на пулер Supabase (порт 6543), но без «?pgbouncer=true» — prepared statements сломают часть запросов.';
  }
  if (url.port === '5432' && hasPgbouncerFlag) {
    return 'DATABASE_URL указывает на прямое соединение (порт 5432), но с «?pgbouncer=true» — флаг здесь лишний и вводит в заблуждение.';
  }
  return null;
}
