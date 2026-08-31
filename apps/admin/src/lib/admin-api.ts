// apps/admin: клиентский fetch-слой. Тот же конверт ответа
// { success: true, data } | { success: false, error }, что и в
// apps/tma/src/lib/api.ts (ApiResponseInterceptor/ApiExceptionFilter,
// apps/api/src/common/) — переиспользуется формат парсинга, не
// переизобретается заново. ОТЛИЧИЕ от apps/tma: аутентификация НЕ
// заголовком X-Telegram-Init-Data, а httpOnly cookie AdminSession —
// credentials: 'include' обязателен на каждый запрос, иначе браузер
// не отправит cookie в cross-origin запросе на api-домен (см.
// admin-auth.controller.ts и create-app.ts, credentials: true в CORS).

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: { message: string; code?: string };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

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
    throw new ApiRequestError('Сервер вернул некорректный ответ', response.status);
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
