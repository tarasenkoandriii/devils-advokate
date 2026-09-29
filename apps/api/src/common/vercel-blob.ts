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

import { fetchWithTimeout } from '../common/fetch-with-timeout';

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
    response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-content-type': contentType,
        'x-access': 'public',
      },
      body,
    }, 45_000); // [external-timeouts]: загрузка файла
  } catch (err) {
    throw new VercelBlobError(`Не удалось загрузить файл в Vercel Blob: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new VercelBlobError(`Vercel Blob вернул ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  return { url: data.url, pathname: data.pathname ?? pathname, contentType: data.contentType ?? contentType };
}

// Пункт [dtp] (§3.4 ТЗ) — putPrivateBlob(), НОВА функція. Доказ ДТП
// вимагає протилежного до PhotoVerification: приватного,
// довгострокового зберігання (не миттєвого публічного доступу з
// негайним видаленням) — тривалість страхового/судового процесу, не
// секунди. access:'private' — той самий x-access заголовок, що вище,
// значення 'private' замість 'public' (контракт відновлений з
// офіційної документації Vercel, той самий клас чесної оговорки, що
// вже застосований до putPublicBlob/deleteBlob — НЕ перевірено живим
// викликом у цьому середовищі розробки). НЕМАЄ функції видалення тут
// навмисно — доказ не підлягає автоматичному видаленню (§2.3 ТЗ).
export async function putPrivateBlob(
  token: string,
  pathname: string,
  body: Buffer,
  contentType: string,
): Promise<VercelBlobPutResult> {
  const url = `${BLOB_API_HOST}/${pathname}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-content-type': contentType,
        'x-access': 'private',
      },
      body,
    }, 45_000); // [external-timeouts]: загрузка файла
  } catch (err) {
    throw new VercelBlobError(`Не удалось загрузить файл в Vercel Blob: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new VercelBlobError(`Vercel Blob вернул ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
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
 * так однозначно подтверждена, как put). Ошибка НЕ ПРОБРАСЫВАЕТСЯ
 * намеренно — если формат окажется неверным при реальном деплое, это
 * не должно ронять уже полученный пользователем результат поиска.
 *
 * Пункт [delete-says-done] 2026-09-06 — НО МОЛЧАТЬ ОБ ЭТОМ НЕЛЬЗЯ.
 * Прежняя версия возвращала `void` и глотала всё: и брошенную ошибку
 * сети, и — что хуже — ЛЮБОЙ не-2xx ответ, потому что `response.ok`
 * не проверялся вовсе. То есть неудачное удаление было неотличимо от
 * удачного для всех вызывающих, а вызывающих двое, и оба на этом
 * строили утверждения:
 *
 *  • экран проверки фото обещает человеку «Ссылка удаляется сразу
 *    после завершения поиска» — БЕЗУСЛОВНО, а фото на это время
 *    реально публично в интернете (осознанный риск, под отдельным
 *    согласием PUBLIC_IMAGE_SEARCH). Если удаление не прошло, фото
 *    остаётся публичным, и человек об этом не узнаёт;
 *  • чистка внешних артефактов считает `evidenceDeleted++` в try и
 *    `evidenceFailed++` в catch — но ловить было нечего, ошибка сюда
 *    не доходила. Счётчик «удалено» был завышен по построению, и
 *    именно он уходит в запись аудита при удалении аккаунта.
 *
 * Решение прежнее — не бросать; новое — СКАЗАТЬ. Вызывающий сам решит,
 * что делать с неудачей, но узнать о ней он обязан.
 *
 * И ОТДЕЛЬНО СНЯТО НЕВЕРНОЕ УТЕШЕНИЕ. В прежнем комментарии стояло:
 * «если удаление не сработало — blob истечёт по TTL кэша Vercel, не
 * остаётся навсегда». Это рассуждение было написано про blob
 * КЭША результата, а у Vercel Blob самого по себе срока жизни нет:
 * загруженный файл лежит, пока его не удалят. Для фотографии
 * человека, лежащей публично, разница принципиальная. */
export interface BlobDeleteResult {
  deleted: boolean;
  /** Почему не удалено — для человека и для счётчиков. null при успехе. */
  reason: string | null;
}

export async function deleteBlob(token: string, blobUrl: string): Promise<BlobDeleteResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${BLOB_API_HOST}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls: [blobUrl] }),
    });
  } catch (err) {
    return { deleted: false, reason: err instanceof Error ? err.message : 'сеть недоступна' };
  }
  if (!response.ok) {
    return { deleted: false, reason: `хранилище ответило ${response.status} ${response.statusText}` };
  }
  return { deleted: true, reason: null };
}
