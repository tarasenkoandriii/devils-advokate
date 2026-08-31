// ПОВТОРНЫЙ АУДИТ 2026-08-31 — тесты для GET /healthz.
//
// Проверяется не только «возвращает ok», но и два свойства, ради
// которых эндпоинт вообще заведён: он должен быть ПУБЛИЧНЫМ (иначе им
// нельзя проверить живость снаружи) и не должен ходить в базу (иначе
// недоступная БД будет выглядеть как мёртвый процесс, и платформа
// начнёт бесконечно перезапускать здоровый инстанс).

import { Test } from '@nestjs/testing';
import { HealthzController } from '../healthz/healthz.controller';
import { HealthzModule } from '../healthz/healthz.module';

describe('HealthzController', () => {
  it('отвечает status=ok и временем старта инстанса', () => {
    const controller = new HealthzController();
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(new Date(result.startedAt).toString()).not.toBe('Invalid Date');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: эндпоинт публичный — на контроллере нет ни одного guard', () => {
    // Guard'ы Nest хранит в метаданных '__guards__'. Если кто-то в
    // будущем накинет сюда TelegramAuthGuard «для единообразия»,
    // эндпоинт перестанет отвечать снаружи и снова станет бесполезен
    // для проверки живости — тест это остановит.
    const classGuards = Reflect.getMetadata('__guards__', HealthzController);
    const methodGuards = Reflect.getMetadata('__guards__', HealthzController.prototype.check);

    expect(classGuards).toBeUndefined();
    expect(methodGuards).toBeUndefined();
  });

  it('модуль не тянет зависимостей — поднимается сам по себе, без БД и ключей', async () => {
    // Если у HealthzModule появятся импорты/провайдеры, эта сборка
    // потребует их наличия и упадёт. Эндпоинт живости должен оставаться
    // независимым от всего остального приложения.
    const moduleRef = await Test.createTestingModule({ imports: [HealthzModule] }).compile();

    const controller = moduleRef.get(HealthzController);
    expect(controller.check().status).toBe('ok');

    await moduleRef.close();
  });
});
