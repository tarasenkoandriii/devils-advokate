// Чекпоинт 1, пункт 11: apiReq/handle() — единая обёртка ответа
//
// Перенос конвенции из других проектов стека: каждый ответ API — один
// и тот же конверт { success, data } | { success: false, error }, чтобы
// фронтенд мог использовать общий apiReq()-хелпер без разбора формата
// ответа для каждого эндпоинта отдельно. Здесь — серверная половина
// (интерфейс ApiResponse + Interceptor, оборачивающий любой успешный
// ответ контроллера); клиентский apiReq()/handle() — фронтенд-код вне
// этого бэкенд-чекпоинта, но должен соответствовать этому контракту.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { decimalsToNumbers } from './money';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Оборачивает успешный ответ любого контроллера в { success: true, data }.
 * Ошибки НЕ оборачиваются здесь — за них отвечает глобальный
 * ExceptionFilter (см. api-response.exception-filter.ts), чтобы формат
 * { success: false, error } был единым и для ожидаемых, и для
 * неожиданных исключений, а не только для explicit-throw случаев.
 */
@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T>> {
    // Decimal(14,2) денежных полей → number на границе API (см. common/money.ts)
    return next.handle().pipe(map((data) => ({ success: true, data: decimalsToNumbers(data) })));
  }
}
