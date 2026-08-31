#!/usr/bin/env node
// Проверка строки подключения к БД. Появился после реальной ошибки на
// проде, которая выглядела так:
//
//   PrismaClientInitializationError: The provided database string is
//   invalid. Error parsing connection string: invalid port number in
//   database URL.
//
// Сообщение Prisma честное, но бесполезное: оно не говорит, ЧТО именно
// в строке не так, и — намеренно — не показывает саму строку, потому
// что в ней пароль. В итоге отладка превращается в разглядывание
// значения в дашборде Vercel, где оно к тому же скрыто звёздочками.
//
// Этот скрипт разбирает строку локально и печатает разбор БЕЗ пароля,
// плюс проверяет типовые причины, на которых спотыкаются чаще всего.
//
//   npm run db:check                     # берёт DATABASE_URL/DIRECT_URL из окружения
//   npm run db:check -- apps/api/.env    # либо читает их из указанного .env
//
// Пароль не печатается никогда — только его длина и набор «опасных»
// символов, которых достаточно, чтобы понять причину.

const fs = require('node:fs');

const VARS = ['DATABASE_URL', 'DIRECT_URL'];

// Символы, которые обязаны быть percent-encoded внутри пароля: иначе
// парсер URL видит границу authority не там, где имел в виду человек, и
// «портом» становится кусок пароля или базы.
const MUST_ENCODE = ['/', '?', '#', '[', ']', '@', ' '];

function readFromEnvFile(path) {
  const values = {};
  const content = fs.readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let raw = match[2].trim();
    // Кавычки в .env — часть синтаксиса файла, а не значения. В
    // дашборде Vercel их быть НЕ должно, и это отдельная проверка ниже.
    const quoted = /^".*"$/.test(raw) || /^'.*'$/.test(raw);
    if (quoted) raw = raw.slice(1, -1);
    values[match[1]] = { value: raw, quotedInFile: quoted };
  }
  return values;
}

// Пароль из СЫРОЙ строки, не через URL: разбор нужен именно тогда,
// когда new URL() падает. Граница userinfo — ПОСЛЕДНИЙ '@' до пути:
// брать первый нельзя (символ может быть внутри пароля), а split('/')
// ломается, если '/' тоже оказался в пароле — то есть ровно в тех
// случаях, ради которых это всё и написано.
function rawPasswordOf(cleaned) {
  const afterScheme = cleaned.slice(cleaned.indexOf('//') + 2);
  const atIdx = afterScheme.lastIndexOf('@');
  if (atIdx < 0) return '';
  const userinfo = afterScheme.slice(0, atIdx);
  return userinfo.split(':').slice(1).join(':');
}

function describe(name, raw) {
  const problems = [];
  const notes = [];

  if (raw === undefined || raw === '') {
    console.log(`\n${name}: не задана`);
    return;
  }

  if (/^["'].*["']$/.test(raw)) {
    problems.push(
      'значение обёрнуто кавычками. В .env это нормально, но если вы скопировали ' +
        'строку ВМЕСТЕ с кавычками в дашборд Vercel — кавычки станут частью значения',
    );
  }
  if (raw !== raw.trim()) problems.push('в начале или конце есть пробелы/перенос строки');
  if (/[\r\n]/.test(raw)) problems.push('внутри строки есть перенос строки');
  if (/\[YOUR-PASSWORD\]|<password>|YOUR_PASSWORD/i.test(raw)) {
    problems.push('в строке остался плейсхолдер пароля из шаблона Supabase');
  }

  const cleaned = raw.trim().replace(/^["']|["']$/g, '');

  let url;
  try {
    url = new URL(cleaned);
  } catch (err) {
    problems.push(`строка не разбирается как URL: ${err.message}`);
    // Самая частая причина непарсящейся строки — спецсимвол в пароле.
    // Проверяем по сырому тексту, раз распарсить не удалось: иначе
    // человек получил бы «Invalid URL» без единой подсказки — ровно то,
    // из-за чего этот скрипт и появился.
    const dangerous = MUST_ENCODE.filter((ch) => rawPasswordOf(cleaned).includes(ch));
    if (dangerous.length) {
      problems.push(
        `похоже, в пароле есть незакодированные символы ${dangerous
          .map((c) => (c === ' ' ? '«пробел»' : c))
          .join(' ')} — именно они и ломают разбор строки`,
      );
    }
    print(name, null, problems, notes);
    return;
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    problems.push(`протокол "${url.protocol}" — ожидается postgresql:// или postgres://`);
  }
  if (url.port === '') {
    notes.push('порт не указан — Postgres по умолчанию 5432; для пулера Supabase нужен 6543');
  } else if (!/^\d+$/.test(url.port)) {
    problems.push(`порт "${url.port}" не число`);
  }

  // Главная причина «invalid port number»: спецсимвол в пароле, из-за
  // которого граница authority уезжает и порт разбирается неправильно.
  const rawPassword = rawPasswordOf(cleaned);
  const dangerous = MUST_ENCODE.filter((ch) => rawPassword.includes(ch));
  if (dangerous.length) {
    problems.push(
      `в пароле есть незакодированные символы ${dangerous.map((c) => (c === ' ' ? '«пробел»' : c)).join(' ')} — ` +
        'их нужно percent-encode (см. подсказку внизу)',
    );
  }

  if (url.hostname.includes('pooler.supabase.com')) {
    if (!url.username.includes('.')) {
      problems.push(
        'хост — пулер Supabase, но имя пользователя без точки. У пулера логин имеет вид ' +
          'postgres.<project-ref>, а не просто postgres',
      );
    }
    if (name === 'DATABASE_URL' && url.port === '5432') {
      notes.push('для DATABASE_URL на serverless ожидается порт 6543 (transaction pooler) + ?pgbouncer=true');
    }
    if (name === 'DATABASE_URL' && url.port === '6543' && !url.search.includes('pgbouncer=true')) {
      notes.push('порт 6543 без ?pgbouncer=true — Prisma не узнает, что перед ней пулер');
    }
    if (name === 'DIRECT_URL' && url.port !== '5432') {
      notes.push('DIRECT_URL должен идти напрямую, порт 5432 — миграции через pgbouncer не работают');
    }
  }

  print(name, url, problems, notes, rawPassword);
}

function print(name, url, problems, notes, password = '') {
  console.log(`\n${name}`);
  if (url) {
    console.log(`  протокол : ${url.protocol}`);
    console.log(`  логин    : ${url.username || '(пусто)'}`);
    console.log(`  пароль   : ${password ? `${password.length} символ(ов), не показываю` : '(пусто)'}`);
    console.log(`  хост     : ${url.hostname}`);
    console.log(`  порт     : ${url.port || '(не задан)'}`);
    console.log(`  база     : ${url.pathname.replace(/^\//, '') || '(не задана)'}`);
    console.log(`  параметры: ${url.search || '(нет)'}`);
  }
  for (const p of problems) console.log(`  ❌ ${p}`);
  for (const n of notes) console.log(`  ⚠️  ${n}`);
  if (!problems.length && !notes.length) console.log('  ✅ проблем не видно');
}

function main() {
  const envFile = process.argv[2];
  let source = 'окружение процесса';
  let values = {};

  if (envFile) {
    if (!fs.existsSync(envFile)) {
      console.error(`Файл ${envFile} не найден`);
      process.exit(1);
    }
    source = envFile;
    const parsed = readFromEnvFile(envFile);
    for (const v of VARS) values[v] = parsed[v]?.value;
  } else {
    for (const v of VARS) values[v] = process.env[v];
  }

  console.log(`Проверка строк подключения (источник: ${source})`);
  for (const v of VARS) describe(v, values[v]);

  console.log(
    '\nЕсли пароль содержит спецсимволы, закодируйте его:\n' +
      "  node -e \"console.log(encodeURIComponent('ваш-пароль'))\"\n" +
      'и подставьте результат в строку вместо исходного пароля.\n' +
      'В дашборде Vercel значение вводится БЕЗ кавычек и без пробелов по краям.',
  );
}

main();
