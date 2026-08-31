// Пункт [blob-upload] 2026-08-31 — прямая загрузка аудио/видео клиентом
// в приватный Vercel Blob, минуя нашу serverless-функцию.
//
// ПОЧЕМУ ЭТО ПОНАДОБИЛОСЬ. Прежняя схема — клиент шлёт байты в
// `POST /conversations/:id/upload`, функция стримит их в AssemblyAI —
// на Vercel не работает вообще, а не «иногда»: тело запроса к
// serverless-функции ограничено 4,5 МБ
// (https://vercel.com/docs/functions/limitations), плюс в
// apps/api/vercel.json стоит maxDuration: 10. Аудиодорожка часового
// разговора — десятки мегабайт. Отказ приходит на уровне платформы,
// ДО нашего кода, поэтому в Runtime Logs его не видно и локально он не
// воспроизводится вовсе. Ни один из аудитов этого не поймал: они
// разбирали код, а лимит лежит в платформе.
//
// Значением переменной это не чинится — нужно, чтобы байты вообще не
// проходили через функцию. Отсюда трёхшаговый протокол Vercel Blob
// (client uploads):
//
//   1. клиент → POST /conversations/:id/audio-upload-token
//      мы проверяем владение разговором и согласия, выдаём
//      одноразовый клиентский токен, привязанный к конкретному
//      pathname, типу содержимого, размеру и сроку;
//   2. клиент → PUT напрямую в blob.vercel-storage.com с этим токеном
//      (multipart для больших файлов) — наш сервер здесь не участвует;
//   3. клиент → POST /conversations/:id/audio-blob {pathname}
//      мы проверяем через head(), что файл реально существует, чей он
//      и какого размера, и только тогда записываем pathname в БД.
//
// ПОЧЕМУ ШАГ 3, А НЕ onUploadCompleted. У handleUpload есть встроенный
// колбэк, который Vercel дёргает сам, server-to-server. Он не подошёл
// по двум причинам, обе практические: он требует публично доступного
// URL нашего API (на localhost и в докере не работает вовсе, то есть
// разработка и прод разошлись бы поведением), и он не даёт клиенту
// узнать, что файл записан — пришлось бы поллить. Явный третий вызов
// проще, тестируется юнит-тестом и одинаково работает везде.
//
// ПРИВАТНОСТЬ. access:'private' — публичной ссылки на файл не
// существует; AssemblyAI получает подписанный URL с коротким сроком
// (presignForTranscription). Файл удаляется сразу по вебхуку, и на
// успехе, и на ошибке — см. deleteAudioBlob() и комментарий у
// audioBlobPathname в schema.prisma.
//
// ЧЕСТНАЯ ГРАНИЦА ПРОВЕРКИ: как и весь остальной внешний периметр
// проекта (AssemblyAI, AI-провайдеры, SerpApi, существующий
// common/vercel-blob.ts), этот код НЕ проверен живым вызовом против
// реального blob-стора — в этой среде разработки нет аккаунта Vercel.
// Проверено другое: контракт SDK (@vercel/blob 2.8.0) прочитан по
// установленному пакету, а не восстановлен по памяти, и покрыт
// юнит-тестами с мокнутым SDK.

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { del, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';

export const BLOB_TOKEN_REF = 'VERCEL_BLOB_READ_WRITE_TOKEN';

/** Префикс пути в сторе. Отдельный от dtp-/photo-verification-файлов
 * намеренно: по pathname должно быть видно, что это транзитное аудио
 * разговора, а не долгоживущее доказательство — их политики удаления
 * прямо противоположны (см. putPrivateBlob в common/vercel-blob.ts). */
const AUDIO_PREFIX = 'conversation-audio/';

/** 500 МБ — не «круглое число на глаз», а верхняя граница того, что
 * имеет смысл отправлять в AssemblyAI одним файлом: у самого
 * провайдера предел на длительность, а не на байты, и часовая запись
 * в разумном битрейте укладывается с большим запасом. Ограничение
 * зашивается в КЛИЕНТСКИЙ ТОКЕН (maximumSizeInBytes), то есть его
 * проверяет сам Vercel при записи — клиент не может его обойти,
 * подменив значение в своём запросе. */
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

/** Токен на запись живёт 30 минут: этого хватает на загрузку большого
 * файла с мобильного канала, но истёкший токен нельзя переиспользовать
 * через неделю, если он утёк из логов клиента. */
const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Подписанный URL для AssemblyAI — 6 часов. Провайдер скачивает файл
 * не мгновенно в момент submitJob, а когда задача доходит до очереди;
 * плюс он может повторить попытку. Час здесь давал бы гонку, сутки —
 * бессмысленно длинное окно для ссылки, которая нужна один раз. */
const PRESIGN_TTL_MS = 6 * 60 * 60 * 1000;

/** Список типов, разрешённых токеном. Видео здесь не ошибка:
 * AssemblyAI принимает видеофайл и извлекает дорожку сам, а для
 * медиа-разбора (YouTube-очередь) пользователь чаще всего приносит
 * именно видео. Проверка снова уходит В ТОКЕН, а не остаётся в нашем
 * коде — Vercel отклонит запись неподходящего типа сам. */
const ALLOWED_CONTENT_TYPES = ['audio/*', 'video/*', 'application/octet-stream'];

export interface ConfirmAudioBlobInput {
  pathname: string;
}

@Injectable()
export class AudioBlobService {
  private readonly logger = new Logger(AudioBlobService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
  ) {}

  private async token(): Promise<string> {
    return this.secrets.resolve(BLOB_TOKEN_REF);
  }

  /** Шаг 1 протокола. Возвращается СЫРОЙ ответ SDK, без нашего конверта
   * {success,data} — его разбирает клиентская половина @vercel/blob, и
   * формат здесь диктуем не мы (поэтому эндпоинт живёт в отдельном
   * контроллере без ApiResponseInterceptor). */
  async issueUploadToken(userId: string, conversationId: string, body: HandleUploadBody, request: unknown) {
    const token = await this.token();

    return handleUpload({
      token,
      body,
      // request нужен SDK только для вычисления callbackUrl под
      // onUploadCompleted, которым мы намеренно не пользуемся (см.
      // шапку файла). Express-объект подходит по форме: SDK читает
      // request.headers[...] для веток, которых у нас нет.
      request: request as Parameters<typeof handleUpload>[0]['request'],
      onBeforeGenerateToken: async () => {
        // ГЛАВНАЯ ПРИЧИНА, ПО КОТОРОЙ ЭТО НЕ ПРОСТО ПРОКСИ К SDK.
        // Токен — это право записать файл в наш стор, поэтому обе
        // проверки обязаны стоять ЗДЕСЬ, до его выдачи, а не на шаге
        // подтверждения: иначе загрузить файл смог бы кто угодно, а
        // отказ пришёл бы уже после того, как байты записаны.
        //
        // Ровно этот класс ошибки повторный аудит 2026-08-30 уже нашёл
        // в streamUploadAudio(): там владение проверялось, а согласия
        // — нет, и режим MAXIMUM_PRIVACY обходился порядком вызовов
        // (upload без transcribe). Здесь порядок такой же опасный,
        // поэтому проверка та же и на том же месте.
        const conversation = await this.findOwnedConversation(userId, conversationId);
        await this.consent.assertAudioMayLeaveDevice(userId, conversation.projectId);

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_AUDIO_BYTES,
          validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
          // Суффикс обязателен: без него два пользователя, загрузившие
          // «запись.m4a», перезаписали бы файл друг друга — pathname
          // приходит от клиента, а не придумывается нами.
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ conversationId, userId }),
        };
      },
    });
  }

  /** Шаг 3 протокола: клиент сообщает, что файл записан. Мы НЕ верим
   * ему на слово — head() проверяет, что blob действительно есть в
   * НАШЕМ сторе (токен стора наш, чужой pathname не найдётся), и
   * заодно даёт реальный размер, а не заявленный клиентом. */
  async confirmUpload(userId: string, conversationId: string, input: ConfirmAudioBlobInput) {
    const conversation = await this.findOwnedConversation(userId, conversationId);
    await this.consent.assertAudioMayLeaveDevice(userId, conversation.projectId);

    const pathname = (input.pathname ?? '').trim();
    if (!pathname) {
      throw new BadRequestException('pathname обязателен — это путь файла, возвращённый загрузкой в Blob');
    }
    // Единственная защита от «подтверди мне чужой файл»: своим
    // считается только то, что лежит под нашим префиксом. Сам по себе
    // префикс не секрет — но вместе с проверкой владения разговором и
    // случайным суффиксом угадать чужой путь нереально.
    if (!pathname.startsWith(AUDIO_PREFIX)) {
      throw new ForbiddenException(`pathname должен начинаться с «${AUDIO_PREFIX}»`);
    }

    const token = await this.token();
    let meta: { size: number; contentType: string; pathname: string };
    try {
      meta = await head(pathname, { token });
    } catch {
      throw new NotFoundException(
        'Файл не найден в хранилище — загрузка не завершилась либо путь указан неверно. Повторите загрузку.',
      );
    }

    if (meta.size > MAX_AUDIO_BYTES) {
      // Практически недостижимо (лимит зашит в токен и проверяется
      // Vercel), но проверка стоит: если Vercel когда-нибудь изменит
      // поведение, лучше отказать здесь, чем отправить в AssemblyAI
      // файл, за который придёт неожиданный счёт.
      await this.deleteByPathname(pathname);
      throw new BadRequestException(`Файл больше ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} МБ`);
    }

    // Если к разговору уже был привязан другой файл — удаляем прежний,
    // а не накапливаем мусор в сторе: перезагрузка файла до старта
    // транскрибации это нормальный сценарий («выбрал не тот файл»).
    if (conversation.audioBlobPathname && conversation.audioBlobPathname !== pathname) {
      await this.deleteByPathname(conversation.audioBlobPathname);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { audioBlobPathname: pathname, audioBlobBytes: meta.size },
    });

    return { pathname: meta.pathname, sizeBytes: meta.size, contentType: meta.contentType };
  }

  /** Подписанный, недолговечный GET-URL для AssemblyAI. Публичной
   * ссылки на файл не существует — это единственный способ его
   * прочитать, и он перестаёт работать через PRESIGN_TTL_MS. */
  async presignForTranscription(pathname: string): Promise<string> {
    const token = await this.token();
    const validUntil = Date.now() + PRESIGN_TTL_MS;

    const signed = await issueSignedToken({
      token,
      pathname,
      operations: ['get'],
      validUntil,
    });

    const { presignedUrl } = await presignUrl(signed, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil,
    });

    return presignedUrl;
  }

  /** Удаление после транскрибации. Best-effort и НЕ бросает: вебхук
   * AssemblyAI приходит один раз, и если уронить его обработку на
   * неудачном удалении файла, потеряется уже полученный транскрипт —
   * цена несопоставима. Неудача попадает в лог, файл остаётся до
   * ручной чистки. Тот же принцип, что у deleteBlob() в
   * common/vercel-blob.ts. */
  async deleteByPathname(pathname: string): Promise<void> {
    try {
      const token = await this.token();
      await del(pathname, { token });
    } catch (err) {
      this.logger.warn(
        `Не удалось удалить аудио-blob «${pathname}»: ${err instanceof Error ? err.message : 'неизвестная ошибка'}. ` +
          'Файл остался в сторе — требуется ручная чистка.',
      );
    }
  }

  /** Удалить файл разговора и снять ссылку одним действием. Порядок
   * важен: сначала физическое удаление, потом обнуление полей —
   * инвариант «pathname в БД ⇒ файл ещё существует» должен нарушаться
   * только в сторону «поле пустое, а файл остался» (это чинится
   * чисткой стора), а не наоборот. */
  async releaseConversationAudio(conversationId: string, pathname: string | null): Promise<void> {
    if (!pathname) return;
    await this.deleteByPathname(pathname);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { audioBlobPathname: null, audioBlobBytes: null },
    });
  }

  private async findOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}
