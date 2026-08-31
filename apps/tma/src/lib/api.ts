// apps/tma: клиентская половина apiReq/handle() (§7.2 devils-advocate-tz.md,
// серверная половина — apps/api/src/common/api-response.interceptor.ts
// и api-exception.filter.ts). Единый конверт ответа: { success: true, data }
// | { success: false, error }.

import { getAuthHeaders } from './telegram';

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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
  };

  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// Экспортирована (не только внутреннее использование apiGet/Post/...)
// — Пункт 34: единственный внешний потребитель — uploadConversationAudio()
// в features.ts, единственная функция файла, которая не использует
// apiReq()/эти пять обёрток (собственный fetch() для стриминга File,
// не JSON.stringify тела) — но парсинг конверта ответа/ошибок должен
// оставаться ОДНИМ и тем же местом кода, не второй копией той же
// логики с рассинхронизирующимся риском (нашедшаяся ранее асимметрия
// — эта функция бросала обычный Error, не ApiRequestError).
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

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'PUT', body }));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'PATCH', body }));
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'DELETE', body }));
}
