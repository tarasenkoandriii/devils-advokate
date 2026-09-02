// Пункт [ai-errors] 2026-09-02 — что из отказа AI видит пользователь.
//
// Найдено аудитом: 50 сервисов заворачивали ЛЮБУЮ ошибку роутера в
// «AI-провайдер недоступен». Под этот текст попадали 429 суточного
// лимита и AIRouterNoCapableModelError («выполните prisma:seed» / «ни у
// одной модели нет ключа») — то есть пробел в конфигурации выглядел как
// отказ внешнего сервиса, и чинить шли не туда.
import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { AIRouterNoCapableModelError } from '../ai-router/ai-router.service';

/** Точная копия шаблона catch-блока сервисов — проверяем то, что
 *  реально стоит в 50 местах, а не хелпер в вакууме. */
function serviceCatchTemplate(err: unknown): never {
  rethrowClientVisibleAiError(err);
  throw new BadGatewayException('Не удалось выполнить — AI-провайдер недоступен.');
}

describe('rethrowClientVisibleAiError', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: «нет модели» доезжает до пользователя как 503 со своим текстом', () => {
    try {
      serviceCatchTemplate(new AIRouterNoCapableModelError('fact-check-ai-fallback'));
      fail('должно было бросить');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const message = (e as ServiceUnavailableException).message;
      expect(message).toContain('prisma:seed');
      expect(message).toContain('ключ провайдера');
      expect(message).not.toContain('AI-провайдер недоступен');
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: 429 суточного лимита остаётся 429, а не превращается в 502', () => {
    const limit = new HttpException('Дневной лимит AI-вызовов исчерпан', HttpStatus.TOO_MANY_REQUESTS);
    try {
      serviceCatchTemplate(limit);
      fail('должно было бросить');
    } catch (e) {
      expect(e).toBe(limit);
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  it('403 отсутствия согласия по-прежнему проходит как есть (прежнее поведение)', () => {
    const forbidden = new ForbiddenException('Consent required: EXTERNAL_AI');
    expect(() => serviceCatchTemplate(forbidden)).toThrow(forbidden);
  });

  it('обычный сбой провайдера остаётся 502 — деградация не расширена', () => {
    try {
      serviceCatchTemplate(new Error('OpenAI-compatible provider error: 500'));
      fail('должно было бросить');
    } catch (e) {
      expect(e).toBeInstanceOf(BadGatewayException);
    }
  });
});
