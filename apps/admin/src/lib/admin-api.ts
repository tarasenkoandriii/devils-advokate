// apps/admin: клиентский fetch-слой. Тот же конверт ответа
// { success: true, data } | { success: false, error }, что и в
// apps/tma/src/lib/api.ts (ApiResponseInterceptor/ApiExceptionFilter,
// apps/api/src/common/) — переиспользуется формат парсинга, не
// переизобретается заново. ОТЛИЧИЕ от apps/tma: аутентификация НЕ
// заголовком X-Telegram-Init-Data, а httpOnly cookie AdminSession —
// credentials: 'include' обязателен на каждый запрос, иначе браузер
// не отправит cookie в cross-origin запросе на api-домен (см.
// admin-auth.controller.ts и create-app.ts, credentials: true в CORS).

// Пункт [green-deploy-pointed-at-localhost] 2026-09-30: адрес API —
// одно место на приложение, с проверкой на платформе.
import { API_BASE_URL } from './api-base-url';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: { message: string; code?: string };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Пункт [cut-off-was-called-malformed] 2026-09-30 — вторая копия
// правила из `apps/tma/src/lib/api.ts`. Обе копии обязаны различать
// «ответа нет» и «ответ не разобран»; что список статусов обрыва в них
// один и тот же, держит
// `apps/api/src/__tests__/audit-2026-09-30-cut-off-was-called-malformed.spec.ts`.
//
// Текст здесь адресован ОПЕРАТОРУ, а не человеку в мини-приложении:
// про суточный потолок он не говорит (операторские действия его не
// тратят), зато прямо называет, что действие могло выполниться
// частично, — для оператора это решение «повторять или сверить».
const CUT_OFF_STATUSES = new Set([408, 502, 503, 504, 524]);

/** Текст для ответа, который не разобрался как JSON. */
export function nonJsonMessage(httpStatus: number): string {
  if (CUT_OFF_STATUSES.has(httpStatus)) {
    return 'Запрос прерван по времени: ответа нет. Действие могло выполниться частично — сверьте состояние, прежде чем повторять.';
  }
  if (httpStatus >= 500) {
    return 'Сбой на стороне API: ответ не разобран. Повторите позже.';
  }
  return 'Ответ API не удалось разобрать.';
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface ApiReqOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function apiReq(path: string, options: ApiReqOptions = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

export async function handle<T>(response: Response): Promise<T> {
  let body: ApiResponse<T>;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(nonJsonMessage(response.status), response.status);
  }

  if (!body.success) {
    throw new ApiRequestError(body.error.message, response.status);
  }
  return body.data;
}

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'GET' }));
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'POST', body }));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'PATCH', body }));
}

export { API_BASE_URL };
