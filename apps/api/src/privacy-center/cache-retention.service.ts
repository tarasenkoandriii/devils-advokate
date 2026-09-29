// Аудит удаления 2026-09-03 — «данные, которые пользователь считает
// удалёнными».
//
// В проекте два кэша, адресуемых СОДЕРЖИМЫМ, а не пользователем:
// TtsCache (текст пользователя + его озвучка, ключ — sha256 текста) и
// FactCheckApiCache (утверждение из разговора, ключ — sha256 нормализованной
// фразы). Ключ по содержимому — осознанное решение: одинаковый запрос от
// разных людей переиспользует один результат. Но у решения есть следствие,
// которое до этого аудита нигде не было закрыто: раз строка не принадлежит
// пользователю, её не касается ни каскад при удалении аккаунта, ни удаление
// проекта, ни отзыв согласий. У TtsCache вдобавок не было срока жизни
// вообще — фраза человека и её аудио оставались в базе навсегда.
//
// Ответ здесь не «привязать кэш к пользователю» (это убило бы сам смысл
// общего кэша и раскрыло бы, кто что произносил), а два других правила:
//   • кэш содержимого обязан ИСТЕКАТЬ — иначе он не кэш, а тихий архив;
//   • кэш хранит ровно то, без чего не работает: фактчеку хватает хэша,
//     дословную реплику он больше не пишет вовсе (см. schema.prisma).
//
// Сторожевая идёт тем же тиком, что чистка протухших джоб: отдельный крон
// добавил бы ещё один секрет и ещё один SQL-файл ради двух DELETE.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Срок жизни озвучки. Достаточно, чтобы кэш реально экономил повторную
 * генерацию в пределах работы над одним разговором, и недостаточно, чтобы
 * стать архивом чужих реплик. Значение назначено, не измерено — как и
 * другие подобные пороги в проекте, честно помечено. */
export const TTS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class CacheRetentionService {
  private readonly logger = new Logger(CacheRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sweep(now = new Date()): Promise<{ ttsCacheReaped: number; factCheckCacheReaped: number }> {
    const ttsCutoff = new Date(now.getTime() - TTS_CACHE_TTL_MS);
    const tts = await this.prisma.ttsCache.deleteMany({ where: { createdAt: { lt: ttsCutoff } } });
    // Протухшие записи фактчека до этого не удалялись, а просто
    // игнорировались при чтении — то есть текст оставался в базе после
    // того, как перестал быть полезным даже нам.
    const factCheck = await this.prisma.factCheckApiCache.deleteMany({ where: { expiresAt: { lt: now } } });
    if (tts.count > 0 || factCheck.count > 0) {
      this.logger.log(`Чистка кэшей: озвучек ${tts.count}, ответов фактчека ${factCheck.count}`);
    }
    return { ttsCacheReaped: tts.count, factCheckCacheReaped: factCheck.count };
  }
}
