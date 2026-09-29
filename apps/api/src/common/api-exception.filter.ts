// Чекпоинт 1, пункт 11: единый формат ошибок — { success: false, error }
//
// Дополняет ApiResponseInterceptor: интерцептор оборачивает успешные
// ответы, этот фильтр — все исключения (HttpException от NestJS guard'ов/
// валидации и непойманные ошибки) в тот же контракт ApiErrorResponse.
// Без этого файла ошибки уходили бы в стандартном Nest-формате
// { statusCode, message, error }, а не в конверте, который ожидает
// фронтендный apiReq()/handle().

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { enumMigrations, latestManualMigration, MANUAL_MIGRATIONS } from '../admin-db-state/manual-migrations';
import { ApiErrorResponse } from './api-response.interceptor';
import { isUnknownEnumValueError } from './enum-migration-lag';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;

    // ПОВТОРНЫЙ АУДИТ 2026-08-31 — отдельная ветка для инфраструктурных
    // ошибок Prisma. Раньше они попадали в общий «Internal server
    // error», и наружу уходило сообщение, из которого нельзя понять
    // вообще ничего: и «схема не накатана», и «база недоступна», и
    // настоящий баг в коде выглядели одинаково. При этом первые две —
    // не баги, а состояние окружения, и чинятся одной командой, если
    // знать какой.
    //
    // Текст ошибки Prisma наружу НЕ отдаётся (там бывают имена таблиц,
    // колонок и фрагменты запроса) — отдаётся только диагноз и действие.
    const infra = this.describeInfrastructureError(exception);
    const status = infra
      ? infra.status
      : isHttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = infra
      ? infra.message
      : isHttpException
        ? this.extractMessage(exception)
        : 'Internal server error';

    if (!isHttpException) {
      // Непредвиденные ошибки логируем с полным стеком — в ответ клиенту
      // стек не уходит никогда, только нейтральное сообщение выше.
      this.logger.error(exception instanceof Error ? exception.stack : exception);
    }

    const body: ApiErrorResponse = {
      success: false,
      error: { message, ...(infra ? {} : this.extractDetails(exception)) },
    };

    response.status(status).json(body);
  }

  /** Распознаёт коды Prisma, которые означают «окружение настроено не
   * до конца», и переводит их в понятный ответ. Коды — из официальной
   * таблицы ошибок Prisma, не догадки. */
  private describeInfrastructureError(
    exception: unknown,
  ): { status: number; message: string } | null {
    const code = (exception as { code?: unknown })?.code;
    const name = (exception as { name?: unknown })?.name;

    if (code === 'P2021' || code === 'P2022') {
      // P2021 — нет таблицы, P2022 — нет колонки. И то и другое значит
      // одно: база не соответствует schema.prisma.
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          'Схема базы данных не накатана или устарела: в базе нет таблиц/колонок, которые описаны в schema.prisma. ' +
          'Выполните `npx prisma db push` против этой базы (через DIRECT_URL, порт 5432 — DDL не проходит через pgbouncer), ' +
          'затем `npm run prisma:seed`. ' +
          // Пункт [latest-migration-was-from-memory] 2026-09-24: число и
          // последняя выводятся из реестра, а не помнятся. Что именно не
          // применено — показывает вкладка «БД» в админке: там у каждой
          // миграции своя проба по схеме.
          `Кроме того, вручную применяются ${MANUAL_MIGRATIONS.length} миграций (последняя — ${latestManualMigration()}); ` +
          'какие из них не прошли на этом инстансе — видно на вкладке «БД» в админке. ' +
          'Подробности — VERCEL.md, раздел «Первый деплой базы данных».',
      };
    }

    // Продолжение аудита 2026-09-02: значение перечисления, которого база
    // ещё не знает (22P02) — ручная миграция ALTER TYPE не применена.
    // Prisma отдельного кода не даёт, распознаём по тексту драйвера.
    if (isUnknownEnumValueError(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        // Пункт [latest-migration-was-from-memory] 2026-09-24: здесь
        // стоял ОДИН файл, названный по памяти, — и притом не тот. Файлов
        // с `ALTER TYPE … ADD VALUE` два, и ошибка от первого отправляла
        // оператора чинить второй. Теперь называются все, из реестра.
        message:
          'База данных не знает нового значения перечисления: не применена ручная миграция ALTER TYPE. ' +
          `Кандидаты (apps/api/prisma/manual-migrations/): ${enumMigrations().map((m) => m.file).join(', ')}. ` +
          'Выполните нужную отдельным вызовом по DIRECT_URL, без транзакции. Это конфигурация, а не сбой функции.',
      };
    }

    if (name === 'PrismaClientInitializationError') {
      // Строка подключения не разбирается или база недоступна. Точный
      // диагноз по самой строке пишет PrismaService при старте (см.
      // prisma/database-url-check.ts) — здесь только направление.
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          'Не удалось подключиться к базе данных: проверьте DATABASE_URL (в логах при старте есть точный диагноз) ' +
          'и доступность инстанса.',
      };
    }

    return null;
  }

  /** code и прочие скалярные поля объекта HttpException — как есть
   * (Пункт [job-domain-v2]: `{ code: 'COMPANY_REQUIRED' }`,
   * `{ existingSheetId }`). message/statusCode/error не дублируются. */
  private extractDetails(exception: unknown): { code?: string; details?: Record<string, unknown> } {
    if (!(exception instanceof HttpException)) return {};
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null) return {};
    const out: { code?: string; details?: Record<string, unknown> } = {};
    for (const [k, v] of Object.entries(response as Record<string, unknown>)) {
      if (k === 'message' || k === 'statusCode' || k === 'error') continue;
      if (k === 'code' && typeof v === 'string') out.code = v;
      else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) (out.details ??= {})[k] = v;
    }
    return out;
  }

  private extractMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      const msg = (response as { message: unknown }).message;
      return Array.isArray(msg) ? msg.join('; ') : String(msg);
    }
    return exception.message;
  }
}
