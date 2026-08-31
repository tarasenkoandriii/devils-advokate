// Пункт 40: safe-url-fetch — первое место в проекте, где бэкенд
// скачивает URL, ПРИСЛАННЫЙ ПОЛЬЗОВАТЕЛЕМ (не заранее настроенный
// админом endpoint AI-провайдера, как везде в ai-provider-client.ts) —
// классический SSRF-риск (Server-Side Request Forgery): злоумышленник
// может попытаться заставить сервер обратиться к внутренней сети/
// метаданным облачного провайдера (169.254.169.254 и т.д.) под видом
// "проверки источника".
//
// ЧЕСТНО О ГРАНИЦАХ ЭТОЙ ЗАЩИТЫ: проверка здесь — по строке URL
// (протокол + hostname-литералы), БЕЗ резолвинга DNS перед
// подключением. Это не защищает от DNS rebinding (домен, который
// резолвится в публичный IP на момент проверки, но в приватный —
// на момент реального запроса) — для полной защиты нужен либо
// резолвинг DNS с явной проверкой IP до подключения, либо прокси с
// egress-фильтрацией на сетевом уровне, ни то ни другое не сделано в
// этом проходе. Базовый, не исчерпывающий барьер — лучше, чем ничего,
// не выдаётся за полную защиту.

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1']);

// Приватные/служебные IPv4-диапазоны — RFC 1918 + loopback + link-local
// (включая 169.254.169.254, метаданные AWS/GCP/Azure — самая частая
// реальная цель SSRF-атак на облачные бэкенды).
function isPrivateIPv4Literal(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, облачные метаданные
  if (a === 127) return true; // loopback
  return false;
}

// ПОВТОРНЫЙ АУДИТ 2026-08-30: приватные IPv6 не проверялись вообще.
// Отдельная функция, а не пара литералов в BLOCKED_HOSTNAMES, потому
// что диапазоны — не точечные адреса: fc00::/7 (уникальные локальные)
// и fe80::/10 (link-local, тот же смысл, что 169.254.0.0/16 у IPv4).
// Плюс IPv4-mapped формы (::ffff:127.0.0.1), которые иначе проходят
// мимо обеих проверок — строкового вида IPv6 и разбора IPv4.
function isPrivateIPv6Literal(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  const h = hostname;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 — unique local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 — link-local
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4Literal(mapped[1]);
  return false;
}

export function isUrlSafeToFetch(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Скобки обязательно снимать: new URL('http://[::1]/').hostname
  // возвращает "[::1]" ВМЕСТЕ с ними, поэтому литерал '::1' в
  // BLOCKED_HOSTNAMES никогда не совпадал — loopback по IPv6 проходил
  // проверку насквозь (найдено повторным аудитом 2026-08-30).
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (isPrivateIPv4Literal(hostname)) return false;
  if (isPrivateIPv6Literal(hostname)) return false;
  return true;
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2_000_000; // 2MB — достаточно для текстовой веб-страницы, не для видео/архивов
const MAX_EXTRACTED_TEXT_LENGTH = 8000; // ограничение на то, сколько текста реально уходит в AI-промпт

export class UnsafeUrlError extends Error {
  constructor(url: string) {
    super(`URL "${url}" не прошёл проверку безопасности (не http/https или указывает на приватный/локальный адрес)`);
    this.name = 'UnsafeUrlError';
  }
}

export class UrlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlFetchError';
  }
}

/** Грубое, не идеальное извлечение читаемого текста из HTML —
 * достаточно для AI-промпта, не полноценный парсер разметки (нет
 * сети для установки библиотек, тот же принцип, что уже применялся к
 * остальным "just fetch" интеграциям проекта). */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Скачивает URL и возвращает извлечённый текст, обрезанный до
 * разумной длины. Бросает UnsafeUrlError/UrlFetchError — вызывающий
 * код решает, как их превращать в HTTP-ответ. */
export async function fetchUrlText(rawUrl: string): Promise<string> {
  if (!isUrlSafeToFetch(rawUrl)) {
    throw new UnsafeUrlError(rawUrl);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow', // ЧЕСТНО: follow-редиректы НЕ перепроверяются isUrlSafeToFetch() повторно на каждом хопе — известное ограничение той же природы, что DNS rebinding выше
      headers: { 'User-Agent': "Devil's Advocate source-check bot (user-provided URL, manual verification feature)" },
    });
  } catch (err) {
    throw new UrlFetchError(`Не удалось загрузить ${rawUrl}: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new UrlFetchError(`${rawUrl} вернул ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new UrlFetchError(`Страница по ссылке ${rawUrl} слишком большая для проверки`);
  }

  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new UrlFetchError(`Страница по ссылке ${rawUrl} слишком большая для проверки`);
  }

  const text = extractTextFromHtml(body);
  if (text.length === 0) {
    throw new UrlFetchError(`Не удалось извлечь текст из ${rawUrl} — возможно, страница не текстовая (изображение/видео/защищённый контент)`);
  }

  return text.slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}
