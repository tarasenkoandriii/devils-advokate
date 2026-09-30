// Пункт 48: PhotoVerificationService (§4.4 ТЗ) — реализует пункт 33
// v3-роадмапа (реверс-поиск фото со скорингом схожести), по прямому
// запросу, после явного обсуждения архитектурного риска (см. диалог
// перед этим пунктом и подробное обоснование над моделью
// PhotoVerification в schema.prisma).
//
// ПОРЯДОК ОПЕРАЦИЙ ВАЖЕН: явное согласие (PUBLIC_IMAGE_SEARCH,
// отдельный тип, не переиспользующий более мягкую формулировку
// EPHEMERAL_SERVER) → rate-limit → загрузка в публичный Vercel Blob →
// поиск через SerpApi → УДАЛЕНИЕ blob'а СРАЗУ, в finally, независимо
// от результата поиска → сохранение находок. Окно публичной
// доступности файла минимизируется на каждом шаге, не устраняется
// полностью — риск принят явно, не просмотрен.
//
// RATE LIMITING — §4.4/§7 ТЗ прямо требует "особенно строгие лимиты"
// для этой фичи. Простая реализация: подсчёт PhotoVerification,
// созданных этим пользователем за последние 24 часа, отказ при
// превышении порога — не полноценная инфраструктура rate-limiting
// (токен-бакет, распределённый счётчик), которой в проекте нет,
// честно минимальный, но реальный лимит, не заглушка.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { putPublicBlob, deleteBlob, VercelBlobError } from '../common/vercel-blob';
import { reverseImageSearch, SerpApiError } from '../common/serpapi-client';
import { ConsentType, PhotoVerificationStatus } from '@prisma/client';
import { resolveBlobToken } from '../common/blob-token';
import { spendLimitByKey } from '../common/spend-limits';
import { mayBePublished, NEVER_PUBLISHED_REFUSAL } from '../common/fact-scope';

/** Пункт [the-meter-counted-rows] 2026-09-30: число жило здесь и
 * только здесь, хотя это потолок РАСХОДОВ (SerpApi платный) и реестр
 * расходов объявляет себя единственным местом, где потолки
 * перечислены. Теперь оно приходит из реестра по ключу; «особенно
 * строгие лимиты» (§4.4 ТЗ) остались зашитыми осознанно — это решение
 * о продукте, а не настройка. */
const DAILY_LIMIT_PER_USER = spendLimitByKey('photo-verification');

/** Действие в журнале, по которому считается суточный расход. */
const PHOTO_VERIFICATION_USAGE_ACTION = 'photo_verification.requested';
const MAX_IMAGE_BYTES = 8_000_000; // 8MB — с запасом под фото документа, не для видео/архивов
// 2026-08-31: резолв токена перенесён в common/blob-token.ts — Vercel
// сам создаёт переменную под именем BLOB_READ_WRITE_TOKEN (без
// префикса), см. объяснение там.
const SERPAPI_KEY_REF = 'SERPAPI_KEY';

@Injectable()
export class PhotoVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
  ) {}

  async verifyPhoto(userId: string, personFactId: string, imageStream: ReadableStream<Uint8Array>, contentType: string) {
    const fact = await this.assertOwnedFact(userId, personFactId);

    // Явное согласие ПЕРЕД любой сетевой активностью — тот же порядок,
    // что уже применяется к EXTERNAL_AI в AIRouterService.
    await this.consent.requireConsent(userId, ConsentType.PUBLIC_IMAGE_SEARCH, fact.projectId ?? undefined);

    await this.assertUnderRateLimit(userId);

    const imageBuffer = await this.bufferStreamWithLimit(imageStream);

    // Отметка ДО первого платного шага: неудачная попытка тоже
    // считается. Недосчитать здесь дороже, чем пересчитать —
    // провайдер мог быть уже задет.
    await this.recordAttempt(userId, personFactId);

    const [blobToken, serpApiKey] = await Promise.all([
      resolveBlobToken(this.secrets),
      this.secrets.resolve(SERPAPI_KEY_REF),
    ]);

    const pathname = `photo-verification/${personFactId}-${Date.now()}`;
    let blobUrl: string | null = null;
    // Пункт [delete-says-done] 2026-09-06: исход удаления публичной
    // копии доходит до человека. Экран обещает ему БЕЗУСЛОВНО —
    // «Ссылка удаляется сразу после завершения поиска», — а фото на
    // это время реально публично в интернете (осознанный риск, под
    // отдельным согласием). Если удаление не прошло, промолчать об
    // этом значит оставить человека с обещанием вместо факта.
    let publicCopy: { removed: boolean; note: string | null } = {
      removed: false,
      note: 'Публичная копия не создавалась.',
    };
    let verifications: unknown[] = [];
    try {
      const blob = await this.uploadToBlob(blobToken, pathname, imageBuffer, contentType);
      blobUrl = blob.url;

      const searchResults = await this.searchReverseImage(serpApiKey, blob.url);

      if (searchResults.length === 0) {
        verifications = [
          await this.prisma.photoVerification.create({
            data: {
              personFactId,
              verificationStatus: PhotoVerificationStatus.NO_SIMILAR_IMAGES_FOUND,
              createdByUserId: userId,
            },
          }),
        ];
      } else {
      verifications = await this.prisma.$transaction(
        searchResults.map((r) =>
          this.prisma.photoVerification.create({
            data: {
              personFactId,
              verificationStatus: PhotoVerificationStatus.SIMILAR_IMAGES_FOUND,
              sourceUrl: r.link ?? null,
              sourceDate: r.date ? this.tryParseDate(r.date) : null,
              matchType: r.title ?? null, // честно текстом — см. обоснование в schema.prisma
              contextDifference: null, // требовало бы сравнения контента, за пределами того, что даёт сырой ответ SerpApi — не выдумывается
              createdByUserId: userId,
            },
          }),
        ),
      );
      }
    } catch (err) {
      if (err instanceof VercelBlobError) {
        throw new BadRequestException(`Не удалось загрузить фото для проверки: ${err.message}`);
      }
      if (err instanceof SerpApiError) {
        throw new BadRequestException(`Не удалось выполнить реверс-поиск: ${err.message}`);
      }
      throw err;
    } finally {
      // Удаление ВСЕГДА, даже при ошибке поиска — минимизация окна
      // публичной доступности не должна зависеть от успеха запроса.
      if (blobUrl) {
        const outcome = await deleteBlob(blobToken, blobUrl);
        publicCopy = outcome.deleted
          ? { removed: true, note: null }
          : {
              removed: false,
              note: `Публичную копию фото удалить НЕ удалось (${outcome.reason ?? 'причина неизвестна'}). Она остаётся доступной по ссылке ${blobUrl} — у Vercel Blob нет собственного срока жизни, файл лежит, пока его не удалят. Сообщите об этом, чтобы копию убрали вручную.`,
            };
      }
    }

    return { verifications, publicCopy };
  }

  async list(userId: string, personFactId: string) {
    await this.assertOwnedFact(userId, personFactId);
    return this.prisma.photoVerification.findMany({
      where: { personFactId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async uploadToBlob(token: string, pathname: string, buffer: Buffer, contentType: string) {
    return putPublicBlob(token, pathname, buffer, contentType);
  }

  private async searchReverseImage(apiKey: string, imageUrl: string) {
    return reverseImageSearch(apiKey, imageUrl);
  }

  private tryParseDate(text: string): Date | null {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async bufferStreamWithLimit(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        throw new BadRequestException('Файл слишком большой для проверки — максимум 8MB');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  /** Пункт [the-meter-counted-rows] 2026-09-30 — потолок считал СТРОКИ,
   * а не вызовы, и у этого было два следствия, оба настоящие.
   *
   * ПЕРВОЕ. Вызов, упавший ДО записи, потолок не тратил. Порядок был:
   * потолок → `putPublicBlob` → `reverseImageSearch` → создание строк.
   * `SerpApiError` и `VercelBlobError` летят в `catch` и превращаются
   * в `BadRequestException` ДО того, как появится хоть одна строка.
   * Значит серия падающих вызовов жгла кредиты SerpApi и запись/
   * удаление в Blob неограниченно. У соседнего потолка
   * (`youtube-search.service.ts`) факт попытки пишется ДО проверки
   * `response.ok` ровно по этой причине — правило в проекте было,
   * просто не везде.
   *
   * ВТОРОЕ. Один УСПЕШНЫЙ поиск с двадцатью совпадениями создавал
   * двадцать строк и съедал суточный потолок 5 целиком. То есть
   * потолок «5 проверок» на деле означал «от одной до пяти проверок,
   * как повезёт с числом найденных картинок» — и человек не мог этого
   * ни предсказать, ни узнать.
   *
   * Считаем ПОПЫТКИ: отметка пишется до первого платного шага, по той
   * же схеме, что у транскрибации и поиска YouTube. */
  private async assertUnderRateLimit(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.auditLogEntry.count({
      where: { actorId: userId, action: PHOTO_VERIFICATION_USAGE_ACTION, createdAt: { gte: since } },
    });
    if (count >= DAILY_LIMIT_PER_USER) {
      throw new ForbiddenException(`Достигнут дневной лимит проверок фото (${DAILY_LIMIT_PER_USER}/день) — попробуйте завтра`);
    }
  }

  private async recordAttempt(userId: string, personFactId: string) {
    await this.prisma.auditLogEntry.create({
      data: {
        actorId: userId,
        action: PHOTO_VERIFICATION_USAGE_ACTION,
        resource: 'PersonFact',
        resourceId: personFactId,
      },
    });
  }

  private async assertOwnedFact(userId: string, personFactId: string) {
    const fact = await this.prisma.personFact.findUnique({
      where: { id: personFactId },
      include: { person: true },
    });
    if (!fact || fact.person.createdByUserId !== userId) {
      throw new NotFoundException(`PersonFact ${personFactId} not found`);
    }
    // Пункт [never-published-was-published] 2026-09-30: проверялось
    // только владение. Фото факта со `scope = PRIVATE_TO_USER`
    // уходило в ПУБЛИЧНЫЙ Blob и в реверс-поиск — то есть на время
    // поиска было реально публично в интернете, при прямом обещании
    // «не публикуется ни при каких обстоятельствах». Отказ, а не
    // молчаливый пропуск: человек должен узнать, почему нельзя.
    if (!mayBePublished(fact.scope)) {
      throw new BadRequestException(NEVER_PUBLISHED_REFUSAL);
    }
    return fact;
  }
}
