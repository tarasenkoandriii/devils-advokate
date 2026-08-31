// ПОВТОРНЫЙ АУДИТ 2026-08-31 — тесты диагностики строки подключения.
//
// Каждый сценарий здесь — не выдуманный, а один из тех, что реально
// приводят к сообщению Prisma «invalid port number in database URL».
// Проверяется в том числе и обратное: корректные строки НЕ должны
// давать ложных срабатываний, иначе в логах появится шум, который
// научатся игнорировать вместе с настоящими ошибками.

import { diagnoseDatabaseUrl, diagnosePoolerMismatch } from '../prisma/database-url-check';

const VALID_POOLED =
  'postgresql://postgres.abcdefgh:SuperSecret123@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true';
const VALID_DIRECT = 'postgresql://postgres.abcdefgh:SuperSecret123@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

describe('diagnoseDatabaseUrl', () => {
  it('корректная пулированная строка — ни одной претензии', () => {
    expect(diagnoseDatabaseUrl(VALID_POOLED)).toEqual([]);
  });

  it('корректная прямая строка — ни одной претензии', () => {
    expect(diagnoseDatabaseUrl(VALID_DIRECT)).toEqual([]);
  });

  it('локальная docker-строка тоже проходит чисто', () => {
    expect(diagnoseDatabaseUrl('postgresql://devils_advocate:devils_advocate@localhost:5432/devils_advocate')).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: значение в кавычках — самая частая причина «invalid port number»', () => {
    // Ровно то, что происходит при копировании строки из .env в UI
    // Vercel вместе с кавычками: парсера dotenv там нет, кавычка
    // остаётся в значении и уезжает в конец — то есть в порт.
    const codes = diagnoseDatabaseUrl(`"${VALID_POOLED}"`).map((p) => p.code);
    expect(codes).toContain('quoted');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: незакодированный «@» в пароле — вторая частая причина', () => {
    const withAt = 'postgresql://postgres.abc:S8p@ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
    const codes = diagnoseDatabaseUrl(withAt).map((p) => p.code);
    expect(codes).toContain('unencoded-at');
  });

  it('percent-encoded «@» (%40) претензий не вызывает — так и надо чинить', () => {
    const encoded = 'postgresql://postgres.abc:S8p%40ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true';
    expect(diagnoseDatabaseUrl(encoded)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: в значение скопировали строку из .env вместе с именем переменной', () => {
    const codes = diagnoseDatabaseUrl(`DATABASE_URL="${VALID_POOLED}"`).map((p) => p.code);
    expect(codes).toContain('name-included');
  });

  it('пароль со спецсимволами, которые кодировать НЕ нужно (!, $, ~), ложных срабатываний не даёт', () => {
    // Проверено на реальном пароле Supabase: «!» относится к sub-delims
    // и в userinfo допустим — percent-encoding ему не требуется.
    const withBangs = 'postgresql://postgres.abc:!!Passw0rd2009!!@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true';
    expect(diagnoseDatabaseUrl(withBangs)).toEqual([]);
  });

  it('пустое значение и пробелы распознаются отдельно', () => {
    expect(diagnoseDatabaseUrl(undefined).map((p) => p.code)).toEqual(['missing']);
    expect(diagnoseDatabaseUrl('   ').map((p) => p.code)).toEqual(['missing']);
    expect(diagnoseDatabaseUrl(`${VALID_POOLED} `).map((p) => p.code)).toContain('whitespace');
  });

  it('чужой протокол называется своим именем, а не «строка не разбирается»', () => {
    const codes = diagnoseDatabaseUrl('mysql://user:pass@host:3306/db').map((p) => p.code);
    expect(codes).toContain('bad-protocol');
  });

  it('совсем не URL — честное «не разбирается», без выдуманных подробностей', () => {
    expect(diagnoseDatabaseUrl('просто строка').map((p) => p.code)).toContain('unparseable');
  });

  it('диагноз НЕ содержит самой строки подключения и пароля — логи Vercel видит вся команда', () => {
    const messages = diagnoseDatabaseUrl(`"${VALID_POOLED}"`).map((p) => p.message).join(' ');
    expect(messages).not.toContain('SuperSecret123');
    expect(messages).not.toContain('pooler.supabase.com');
  });
});

describe('diagnosePoolerMismatch', () => {
  it('порт 6543 без pgbouncer=true — предупреждение (prepared statements сломают часть запросов)', () => {
    const withoutFlag = VALID_POOLED.replace('?pgbouncer=true', '');
    expect(diagnosePoolerMismatch(withoutFlag)).toContain('6543');
  });

  it('порт 5432 с pgbouncer=true — предупреждение о лишнем флаге', () => {
    expect(diagnosePoolerMismatch(`${VALID_DIRECT}?pgbouncer=true`)).toContain('5432');
  });

  it('согласованные варианты предупреждений не дают', () => {
    expect(diagnosePoolerMismatch(VALID_POOLED)).toBeNull();
    expect(diagnosePoolerMismatch(VALID_DIRECT)).toBeNull();
  });
});
