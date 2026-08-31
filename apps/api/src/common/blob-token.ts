// 2026-08-31 — токен Vercel Blob под ДВУМЯ именами.
//
// Обнаружено на реальном деплое, не аудитом кода: наши сервисы резолвят
// `VERCEL_BLOB_READ_WRITE_TOKEN` (так переменная названа в
// .env.example и во всей документации), но когда стор подключают через
// UI Vercel (Storage → Blob → Connect Project), Vercel создаёт
// переменную с именем `BLOB_READ_WRITE_TOKEN` — без префикса. Человек
// всё сделал правильно, кнопкой из официального UI, а фича отвечает
// «Secret not found for credentialRef VERCEL_BLOB_READ_WRITE_TOKEN» —
// и по этому сообщению невозможно догадаться, что токен в проекте ЕСТЬ,
// просто под соседним именем.
//
// Поэтому пробуем оба имени, в порядке «наше документированное → то,
// которое создаёт Vercel». Не наоборот: если заданы оба, побеждает
// явно прописанное человеком, а не автоматикой.

import { SecretsService } from '../secrets/secrets.service';

export const BLOB_TOKEN_REFS = ['VERCEL_BLOB_READ_WRITE_TOKEN', 'BLOB_READ_WRITE_TOKEN'] as const;

export async function resolveBlobToken(secrets: SecretsService): Promise<string> {
  for (const ref of BLOB_TOKEN_REFS) {
    try {
      return await secrets.resolve(ref);
    } catch {
      // пробуем следующее имя
    }
  }
  throw new Error(
    'Токен Vercel Blob не найден ни как VERCEL_BLOB_READ_WRITE_TOKEN, ни как BLOB_READ_WRITE_TOKEN. ' +
      'Создайте Blob-стор (Storage → Blob) и подключите его к проекту API (Connect Project) — либо задайте переменную вручную.',
  );
}
