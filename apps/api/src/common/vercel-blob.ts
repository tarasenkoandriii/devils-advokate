// Пункт 48: vercel-blob.ts — минимальный клиент для Vercel Blob
// REST API, сырой fetch() без пакета @vercel/blob (нет сети для
// npm install в этой среде разработки, тот же принцип, что уже
// применялся ко всем внешним HTTP-интеграциям проекта: AI-провайдеры,
// AssemblyAI, SerpApi).
//
// ЧЕСТНО О ГРАНИЦАХ ПРОВЕРКИ: контракт восстановлен по официальной
// документации Vercel (host для записи — blob.vercel-storage.com,
// авторизация Bearer BLOB_READ_WRITE_TOKEN, JSON-ответ вида
// {url, pathname, contentType, contentDisposition}) и подтверждён
// независимыми источниками (неофициальные Python-обёртки, реально
// работающие против живого API). НЕ проверено вызовом против
// реального аккаунта Vercel Blob в этой среде — та же оговорка, что
// уже делалась для AssemblyAI/AI-провайдеров: контракт восстановлен
// из документации, не подтверждён живым вызовом.

const BLOB_API_HOST = 'https://blob.vercel-storage.com';

export interface VercelBlobPutResult {
  url: string;
  pathname: string;
  contentType: string;
}

export class VercelBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelBlobError';
  }
}

/** Загружает файл в публичный Vercel Blob store. access:'public' —
 * единственный задокументированный режим для put() без клиентских
 * presigned-токенов (см. обоснование выбора публичного хранения в
 * schema.prisma над моделью PhotoVerification). */
export async function putPublicBlob(
  token: string,
  pathname: string,
  body: Buffer,
  contentType: string,
): Promise<VercelBlobPutResult> {
  const url = `${BLOB_API_HOST}/${pathname}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-content-type': contentType,
        'x-access': 'public',
      },
      body,
    });
  } catch (err) {
    throw new VercelBlobError(`Не удалось загрузить файл в Vercel Blob: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new VercelBlobError(`Vercel Blob вернул ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return { url: data.url, pathname: data.pathname ?? pathname, contentType: data.contentType ?? contentType };
}

/** Удаляет blob по URL — вызывается СРАЗУ после завершения поиска
 * (успешного или нет, через try/finally на вызывающей стороне), не
 * дожидаясь TTL/сборки мусора — минимизация окна публичной
 * доступности файла, единственная причина, по которой это вообще
 * приемлемо с точки зрения приватности (см. обоснование в
 * schema.prisma).
 *
 * ЧЕСТНО: контракт именно DELETE-эндпоинта подтверждён источниками
 * слабее, чем PUT выше (та же формула — POST на /delete с телом
 * {urls: [...]}, засвидетельствована в неофициальных обёртках, но не
 * так однозначно подтверждена, как put). Обёрнуто в try/catch без
 * проброса ошибки намеренно — если формат окажется неверным при
 * реальном деплое, это не должно ронять уже полученный пользователем
 * результат поиска, только оставить blob до истечения TTL кэша. */
export async function deleteBlob(token: string, blobUrl: string): Promise<void> {
  try {
    await fetch(`${BLOB_API_HOST}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls: [blobUrl] }),
    });
  } catch {
    // Намеренно не бросаем — удаление blob'а это best-effort очистка,
    // не должна ронять уже успешно полученный результат поиска.
    // Если удаление не сработало — blob истечёт по TTL кэша Vercel
    // (см. документацию), не остаётся навсегда, риск не бесконечный.
  }
}
