// ПОВТОРНЫЙ АУДИТ 2026-08-31 — тест, которого в проекте не было и
// который нужно было написать первым.
//
// Что случилось: приложение не поднималось ВООБЩЕ — ни на Vercel, ни
// локально, ни в докер-стенде:
//
//   Nest can't resolve dependencies of the SecretsService
//   (Symbol(SECRET_PROVIDER), ?). Please make sure that the argument
//   Object at index [1] is available in the SecretsModule context.
//
// Причина — второй параметр конструктора `ttlMs = 5 * 60 * 1000` без
// аннотации типа: tsc эмитит для него `design:paramtypes` = Object, Nest
// читает это как зависимость и ищет провайдер с токеном Object.
// Подробный разбор — в комментарии в secrets.service.ts.
//
// ПОЧЕМУ ЭТОГО НЕ ПОЙМАЛИ 1300 ЗЕЛЁНЫХ ТЕСТОВ. Все они юнитовые: сервис
// создаётся напрямую (`new SecretsService(provider, 60_000)`), фейковый
// prisma передаётся аргументом, DI-контейнер Nest не участвует вообще.
// Такой набор проверяет логику сервисов и не проверяет ровно одну вещь —
// собирается ли из них приложение. Ошибка в проводке (DI, импорты
// модулей, циклические зависимости) для него невидима по построению.
//
// Этот тест закрывает именно ту дыру: собирает НАСТОЯЩИЙ контейнер из
// AppModule — все ~100 модулей, все провайдеры, все зависимости.
// Test.compile() строит граф и инстанцирует провайдеров, но НЕ вызывает
// onModuleInit, поэтому база данных, сеть и ключи не нужны.

import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

// PrismaService подменяется заглушкой: настоящий PrismaClient при
// создании грузит нативный движок Prisma, а тесту нужен только граф
// зависимостей. Заодно тест остаётся полностью офлайновым — ни базы,
// ни бинарей движка, ни ключей. Все ОСТАЛЬНЫЕ провайдеры создаются
// по-настоящему, а именно среди них и живут ошибки проводки.
const prismaStub = {
  $connect: async () => undefined,
  $disconnect: async () => undefined,
};

function buildTestingModule() {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .compile();
}

describe('Bootstrap приложения (DI-контейнер целиком)', () => {
  // Сборка ~100 модулей заметно дольше обычного юнит-теста.
  jest.setTimeout(60_000);

  it('КЛЮЧЕВОЙ ТЕСТ: AppModule собирается — все зависимости всех провайдеров разрешаются', async () => {
    // Именно этот вызов падал бы с «can't resolve dependencies of the
    // SecretsService». Любая будущая ошибка проводки — незарегистрированный
    // провайдер, забытый импорт модуля, параметр конструктора без
    // аннотации типа, циклическая зависимость — тоже приведёт сюда.
    const moduleRef = await buildTestingModule();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('SecretsService получает провайдера секретов и работает с TTL по умолчанию', async () => {
    const moduleRef = await buildTestingModule();

    // Резолвим сервис из настоящего контейнера, а не создаём вручную —
    // иначе тест снова не проверял бы DI.
    const { SecretsService } = await import('../secrets/secrets.service');
    const secrets = moduleRef.get(SecretsService, { strict: false });

    expect(secrets).toBeDefined();
    // Значение секрета берётся из process.env через EnvSecretProvider —
    // проверяем сквозной путь резолва, а не только факт инстанцирования.
    process.env.__TEST_SECRET__ = 'value-from-env';
    await expect(secrets.resolve('__TEST_SECRET__')).resolves.toBe('value-from-env');
    delete process.env.__TEST_SECRET__;

    await moduleRef.close();
  });
});
