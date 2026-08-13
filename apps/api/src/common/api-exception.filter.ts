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
import { ApiErrorResponse } from './api-response.interceptor';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? this.extractMessage(exception)
      : 'Internal server error';

    if (!isHttpException) {
      // Непредвиденные ошибки логируем с полным стеком — в ответ клиенту
      // стек не уходит никогда, только нейтральное сообщение выше.
      this.logger.error(exception instanceof Error ? exception.stack : exception);
    }

    const body: ApiErrorResponse = {
      success: false,
      error: { message },
    };

    response.status(status).json(body);
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
