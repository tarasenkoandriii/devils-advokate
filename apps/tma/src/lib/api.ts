// apps/tma: клиентская половина apiReq/handle() (§7.2 devils-advocate-tz.md,
// серверная половина — apps/api/src/common/api-response.interceptor.ts
// и api-exception.filter.ts). Единый конверт ответа: { success: true, data }
// | { success: false, error }.

import { getAuthHeaders } from './telegram';

// Пункт [green-deploy-pointed-at-localhost] 2026-09-30: адрес API —
// одно место на приложение, с проверкой на платформе.
import { API_BASE_URL } from './api-base-url';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: { message: string; code?: string; details?: Record<string, unknown> };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Пункт [error-language] 2026-09-04 — страховка в одном месте.
//
// НАЙДЕНО: 123 места в TMA показывают человеку `err.message` дословно, а
// на стороне API из 776 сообщений исключений 299 были без единой
// кириллической буквы — то есть написаны для разработчика, а доходили до
// человека. Он видел «SparringSession cmf3x9q… is already ended» или
// «DtpParticipant cmf… not found»: чужой язык плюс внутренний
// идентификатор, из которого ничего не следует.
//
// Ответы на его собственное действие (400 и отказы входа) переписаны
// по-русски поимённо — там осмысленная фраза лучше любой общей. Но 231
// сообщение класса «не найдено» переписывать НЕ нужно: по конвенции
// проекта они намеренно неинформативны («один ответ на „нет“ и „не ваш“»,
// чтобы не подтверждать существование чужих объектов). Их правильное
// место — не на экране.
//
// Поэтому здесь одно правило вместо 231 правки: СООБЩЕНИЕ БЕЗ КИРИЛЛИЦЫ
// написано не для человека. Такое подменяется человеческой фразой по
// статусу ответа, а исходный текст остаётся на объекте ошибки в
// `technicalMessage` — для диагностики он не потерян, просто перестаёт
// быть тем, что читают.
//
// Почему признак — кириллица, а не статус: русские сообщения продукта
// (только среди 400-х их 477) обязаны доходить до человека дословно, они
// для него и написаны. «Есть кириллица» разделяет эти два множества
// точно и не требует ни списка исключений, ни новой разметки на стороне
// API.
const CYRILLIC = /[А-Яа-яЁё]/;

const HUMAN_BY_STATUS: Record<number, string> = {
  400: 'Запрос не принят: данные не подошли. Проверьте заполненное и попробуйте ещё раз.',
  401: 'Не удалось подтвердить вход. Закройте и откройте приложение заново.',
  403: 'Это действие вам недоступно.',
  404: 'Не нашли то, что вы открыли: возможно, оно удалено или ссылка устарела.',
  409: 'Сейчас это невозможно: состояние уже изменилось.',
  413: 'Слишком большой объём данных для одного запроса.',
  429: 'Слишком часто — подождите немного и повторите.',
};

const HUMAN_FALLBACK = 'Не удалось выполнить действие. Если повторяется, дело на нашей стороне.';

export function humanizeApiError(message: string, httpStatus: number): string {
  if (CYRILLIC.test(message)) return message;
  if (httpStatus >= 500) return 'Сбой на нашей стороне. Повторите позже.';
  return HUMAN_BY_STATUS[httpStatus] ?? HUMAN_FALLBACK;
}

// Пункт [cut-off-was-called-malformed] 2026-09-30 — что человек читает,
// когда платформа обрывает запрос по времени.
//
// НАЙДЕННОЕ. Тело, которое не разобралось как JSON, давало ОДНУ фразу
// на все случаи: «Сервер вернул некорректный ответ». Самый частый
// случай при этом — не некорректный ответ, а ОТСУТСТВИЕ ответа:
// предел одного вызова функции 60 с, а один шаг модели с повтором
// просил до 90 с (см. `apps/api/src/ai-router/sync-budget.ts`), и
// платформа отдаёт свою страницу 504 — не JSON. Человек читал
// утверждение о сервере, которое не было правдой: ничего некорректного
// сервер не вернул, запрос был прерван. Хуже того, фраза с кириллицей
// возвращается из `humanizeApiError` дословно, то есть ветка «сбой на
// нашей стороне» для статусов 5xx при платформенном обрыве не
// достигалась НИКОГДА.
//
// И вторая половина, важная для доверия: расход отмечается ДО платного
// шага (иначе недосчёт при отказе провайдера), поэтому оборванная
// попытка суточный потолок уже израсходовала. Говорить «попробуйте
// ещё раз», не сказав этого, — отправлять человека тратить второй раз.
const CUT_OFF_STATUSES = new Set([408, 502, 503, 504, 524]);

/** Текст для ответа, который не разобрался как JSON. Разделяет «нет
 *  ответа» и «ответ не разобран»: это разные события, и делать человеку
 *  из них одно — врать в одном из двух случаев. */
export function nonJsonMessage(httpStatus: number): string {
  if (CUT_OFF_STATUSES.has(httpStatus)) {
    return 'Запрос был прерван по времени: ответ не пришёл. Часть работы могла успеть выполниться, а суточный лимит за эту попытку уже учтён — прежде чем повторять, проверьте состояние. Если повторяется, дело на нашей стороне.';
  }
  if (httpStatus >= 500) {
    return 'Сбой на нашей стороне: ответ не разобран. Повторите позже.';
  }
  return HUMAN_BY_STATUS[httpStatus] ?? 'Ответ сервера не удалось разобрать. Если повторяется, дело на нашей стороне.';
}

export class ApiRequestError extends Error {
  /** Исходный текст ответа API. Совпадает с `message`, когда сообщение
   * писалось для человека; иначе — то инженерное, что заменено. */
  public readonly technicalMessage: string;

  constructor(
    message: string,
    public readonly httpStatus: number,
    /** Пункт [job-domain-v2]: код и детали ожидаемой ошибки (409 «лист уже
     * открыт» несёт existingSheetId; 409 COMPANY_REQUIRED — code). */
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(humanizeApiError(message, httpStatus));
    this.name = 'ApiRequestError';
    this.technicalMessage = message;
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
    throw new ApiRequestError(nonJsonMessage(response.status), response.status);
  }

  if (!body.success) {
    throw new ApiRequestError(body.error.message, response.status, body.error.code, body.error.details);
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
