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

const DAILY_LIMIT_PER_USER = 5; // "особенно строгие лимиты" (§4.4 ТЗ) — намеренно низкое число, не для массового использования
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

    const [blobToken, serpApiKey] = await Promise.all([
      resolveBlobToken(this.secrets),
      this.secrets.resolve(SERPAPI_KEY_REF),
    ]);

    const pathname = `photo-verification/${personFactId}-${Date.now()}`;
    let blobUrl: string | null = null;
    try {
      const blob = await this.uploadToBlob(blobToken, pathname, imageBuffer, contentType);
      blobUrl = blob.url;

      const searchResults = await this.searchReverseImage(serpApiKey, blob.url);

      if (searchResults.length === 0) {
        return [
          await this.prisma.photoVerification.create({
            data: {
              personFactId,
              verificationStatus: PhotoVerificationStatus.NO_SIMILAR_IMAGES_FOUND,
              createdByUserId: userId,
            },
          }),
        ];
      }

      return this.prisma.$transaction(
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
        await deleteBlob(blobToken, blobUrl);
      }
    }
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
    // eslint-disable-next-line no-constant-condition
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

  private async assertUnderRateLimit(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.photoVerification.count({
      where: { createdByUserId: userId, createdAt: { gte: since } },
    });
    if (count >= DAILY_LIMIT_PER_USER) {
      throw new ForbiddenException(`Достигнут дневной лимит проверок фото (${DAILY_LIMIT_PER_USER}/день) — попробуйте завтра`);
    }
  }

  private async assertOwnedFact(userId: string, personFactId: string) {
    const fact = await this.prisma.personFact.findUnique({
      where: { id: personFactId },
      include: { person: true },
    });
    if (!fact || fact.person.createdByUserId !== userId) {
      throw new NotFoundException(`PersonFact ${personFactId} not found`);
    }
    return fact;
  }
}
