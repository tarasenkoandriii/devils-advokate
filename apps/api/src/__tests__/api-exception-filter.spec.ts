// ПОВТОРНЫЙ АУДИТ 2026-08-31 — тесты на перевод инфраструктурных ошибок
// Prisma в понятный ответ.
//
// Повод: на проде вход в админку отдавал «Internal server error», а в
// логах лежало «The table public.users does not exist» — то есть схема
// просто не была накатана. Внешне это неотличимо от настоящего бага в
// коде, и время уходит не туда.
//
// Отдельно проверяется, что наружу не утекают подробности запроса
// Prisma: в её сообщениях бывают имена таблиц, колонок и куски SQL.

import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { MANUAL_MIGRATIONS, enumMigrations, latestManualMigration } from '../admin-db-state/manual-migrations';

function runFilter(exception: unknown): { status: number; body: any } {
  const filter = new ApiExceptionFilter();
  let status = 0;
  let body: any;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };
  const host: any = { switchToHttp: () => ({ getResponse: () => response }) };

  filter.catch(exception, host);
  return { status, body };
}

describe('ApiExceptionFilter — инфраструктурные ошибки Prisma', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: P2021 (нет таблицы) → 503 с инструкцией, а не «Internal server error»', () => {
    const prismaError = Object.assign(new Error('The table `public.users` does not exist'), {
      code: 'P2021',
      name: 'PrismaClientKnownRequestError',
    });

    const { status, body } = runFilter(prismaError);

    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('prisma db push');
    expect(body.error.message).toContain('DIRECT_URL');
  });

  it('P2022 (нет колонки) — тот же диагноз: база отстала от schema.prisma', () => {
    const prismaError = Object.assign(new Error('The column `users.foo` does not exist'), { code: 'P2022' });
    expect(runFilter(prismaError).status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('PrismaClientInitializationError → 503 с отсылкой к логам старта, где лежит точный диагноз', () => {
    const initError = Object.assign(new Error('invalid port number in database URL'), {
      name: 'PrismaClientInitializationError',
    });

    const { status, body } = runFilter(initError);

    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.error.message).toContain('DATABASE_URL');
  });

  it('наружу не уходят подробности запроса Prisma — ни имён таблиц, ни текста ошибки', () => {
    const prismaError = Object.assign(new Error('The table `public.secret_internal_table` does not exist'), {
      code: 'P2021',
    });

    const { body } = runFilter(prismaError);

    expect(body.error.message).not.toContain('secret_internal_table');
  });

  it('обычные HttpException не затронуты — статус и сообщение остаются своими', () => {
    const { status, body } = runFilter(new HttpException('Consent required: RECORDING', HttpStatus.FORBIDDEN));

    expect(status).toBe(HttpStatus.FORBIDDEN);
    expect(body.error.message).toBe('Consent required: RECORDING');
  });

  it('непредвиденная ошибка по-прежнему отдаёт нейтральное сообщение, без стека', () => {
    const { status, body } = runFilter(new Error('boom at line 42 of secret-file.ts'));

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error.message).toBe('Internal server error');
  });
});

// Пункт [latest-migration-was-from-memory] 2026-09-24. Реестр миграций
// проверялся отдельной спекой, но САМО СООБЩЕНИЕ — ничем: подмена
// `enumMigrations()` на `MANUAL_MIGRATIONS` в фильтре не ловилась, и
// оператор получал бы список из девятнадцати файлов вместо двух. Это тот
// же дефект в миниатюре: проверка написана на функцию, а не на текст,
// который читает человек.
describe('ApiExceptionFilter — диагностика неприменённых ручных миграций', () => {
  const enumError = () =>
    Object.assign(new Error('invalid input value for enum "ProjectMode": "EMPLOYER_HIRING"'), {
      code: 'P2010',
      name: 'PrismaClientKnownRequestError',
    });

  it('КЛЮЧЕВОЙ ТЕСТ: сообщение об ошибке перечисления называет ТОЛЬКО ALTER TYPE-миграции', () => {
    const { status, body } = runFilter(enumError());
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);

    const message: string = body.error.message;
    const named = MANUAL_MIGRATIONS.filter((m) => message.includes(m.file)).map((m) => m.file).sort();
    const shouldName = enumMigrations().map((m) => m.file).sort();

    // Прямая проба: все нужные названы.
    expect(named).toEqual(shouldName);
    // Обратная проба: их меньше, чем весь реестр. Без неё равенство выше
    // выполнялось бы и тогда, когда названы все девятнадцать, — лишь бы
    // enumMigrations() вернула столько же.
    expect(named.length).toBeLessThan(MANUAL_MIGRATIONS.length);
    expect(named.length).toBeGreaterThan(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «последняя миграция» в P2021 — действительно последняя по реестру, а не помнится', () => {
    const prismaError = Object.assign(new Error('The table `public.users` does not exist'), { code: 'P2021' });
    const message: string = runFilter(prismaError).body.error.message;

    expect(message).toContain(latestManualMigration());
    expect(message).toContain(String(MANUAL_MIGRATIONS.length));
    // Обратная проба: самая ранняя миграция реестра в сообщении НЕ
    // названа — иначе «последняя» ничего не отбирает.
    const earliest = [...MANUAL_MIGRATIONS].map((m) => m.file).sort()[0];
    if (earliest !== latestManualMigration()) expect(message).not.toContain(earliest);
  });
});
