// Пункт [ai-errors] 2026-09-02 — что из отказа AI видит пользователь.
//
// НАЙДЕНО АУДИТОМ. Все 50 сервисов-потребителей роутера были написаны
// по одному шаблону:
//
//   catch (err) {
//     if (err instanceof ForbiddenException) throw err;
//     throw new BadGatewayException('… AI-провайдер недоступен …');
//   }
//
// В «всё остальное» попадали ровно те ошибки, ради которых в роутере
// писались точные тексты:
//
//   • HttpException(429) суточного лимита вызовов — «превышен лимит»
//     превращалось в «провайдер недоступен», и пользователь ждал
//     починки того, что не сломано;
//   • AIRouterNoCapableModelError — «выполните prisma:seed» / «ни у
//     одной модели не задан ключ»: пробел в КОНФИГУРАЦИИ выглядел как
//     отказ внешнего сервиса. Это ровно та подмена, которую проект
//     чинит с 2026-09-01 (AUDIT-AI-CAPABILITIES, [router-simplify],
//     [router-lanes]) — и она возвращалась на последнем метре, уже
//     после роутера.
//
// Здесь один общий шлюз вместо 50 копий условия: копия проверки в
// каждой точке — способ разъехаться, уже дважды стоивший проекту дыр.
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AIRouterNoCapableModelError } from '../ai-router/ai-router.service';

/**
 * Пропускает наружу ошибки, у которых уже есть правильный смысл и код,
 * и ничего не делает для всех прочих — вызывающий код после этого
 * бросает свой BadGateway с человеческим текстом про свою фичу.
 *
 * Вызывать ПЕРВОЙ строкой catch-блока вокруг вызова AIRouter.
 */
export function rethrowClientVisibleAiError(err: unknown): void {
  // ForbiddenException (нет согласия), BadRequestException, 429 лимита —
  // всё это уже HttpException с осмысленным кодом и текстом.
  if (err instanceof HttpException) throw err;

  // Конфигурация, а не сбой: 503 + точный текст, что именно сделать.
  if (err instanceof AIRouterNoCapableModelError) {
    throw new ServiceUnavailableException(err.message);
  }
}
