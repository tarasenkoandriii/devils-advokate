// Пункт 87: VoiceEmbeddingService — голосовой отпечаток (persistent
// speaker verification), идея за пределами исходной ТЗ, реализована
// по прямому запросу после явного технического разбора (sherpa-onnx,
// WASM-путь). Подробности выбора технологии — см. /TODO.md, «Идеи за
// пределами ТЗ».
//
// BACKEND НИКОГДА НЕ ВИДИТ ЗВУК — только уже посчитанный клиентом
// (WASM) вектор эмбеддинга. Извлечение эмбеддинга происходит в TMA
// (lib/voice-embedding.ts), не здесь — тот же принцип, что вся
// остальная акустика проекта (Пункт 81 и далее).
//
// requireConsent(VOICE_BIOMETRIC) — отдельный, специфический тип
// согласия, не переиспользует VOICE_PROCESSING (тот про синтез речи,
// не про постоянный биометрический идентификатор) — обоснование в
// самой схеме над enum ConsentType.
//
// isMatch()/cosineSimilarity() — ЧИСТЫЕ ФУНКЦИИ, вынесены отдельно
// от остального сервиса намеренно, чтобы быть реально тестируемыми
// числовыми тестами на известных векторах, тот же принцип, что
// computeRmsDb() (Пункт 81) — не полагаться только на то, что "должно
// работать", а математически проверить на конкретных значениях.

import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';

const DEFAULT_THRESHOLD = 0.5; // не откалибровано на реальных голосах — честная оговорка, см. /TODO.md

/** Косинусное сходство двух векторов — [-1, 1], 1 = идентичны по
 * направлению. Чистая математика, без побочных эффектов. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Векторы разной размерности: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0; // нулевой вектор — честно "нет сходства", не деление на 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Сравнение с порогом — ОДНО место, и `verifyDetailed` зовёт именно
 * его.
 *
 * Пункт [written-for-the-person-never-delivered] 2026-09-30: функция
 * была реализована, покрыта тестом и НЕ ВЫЗЫВАЛАСЬ — продовый путь
 * повторял то же сравнение собственным выражением
 * (`similarity >= threshold`). Две копии одного правила о пороге
 * голосовой биометрии, из которых проверена была неиспользуемая: тест
 * зеленел на одной, решение о том, ЧЬИ слова уйдут в разбор
 * поведения собеседника, принимала другая. */
export function isMatch(reference: number[], candidate: number[], threshold: number = DEFAULT_THRESHOLD): boolean {
  return cosineSimilarity(reference, candidate) >= threshold;
}

@Injectable()
export class VoiceEmbeddingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  /** "Один эмбеддинг на пользователя" — повторный вызов обновляет
   * существующую запись (upsert), не создаёт вторую. */
  async enroll(userId: string, embedding: number[]) {
    if (embedding.length === 0) {
      throw new BadRequestException('embedding не может быть пустым');
    }
    await this.consent.requireConsent(userId, ConsentType.VOICE_BIOMETRIC);

    return this.prisma.voiceEmbedding.upsert({
      where: { userId },
      create: { userId, embedding, dimension: embedding.length },
      update: { embedding, dimension: embedding.length },
    });
  }

  async getReference(userId: string): Promise<number[] | null> {
    const record = await this.prisma.voiceEmbedding.findUnique({ where: { userId } });
    return record?.embedding ?? null;
  }

  /** Сверяет кандидатный вектор (например, из live-сессии) с уже
   * сохранённым эталоном пользователя. Возвращает null, если эталона
   * ещё нет — честно, не выдумывает результат сравнения из ничего. */
  async verify(userId: string, candidateEmbedding: number[], threshold: number = DEFAULT_THRESHOLD): Promise<boolean | null> {
    return (await this.verifyDetailed(userId, candidateEmbedding, threshold)).isMatch;
  }

  /** Пункт [voice-attribution] 2026-09-05 — ответ несёт основание, а не
   * один вердикт.
   *
   * НАЙДЕНО: наружу уходило `{ isMatch }` — голое «это вы / это не вы»,
   * полученное сравнением с порогом, который в этом же файле честно
   * назван неоткалиброванным на реальных голосах. Дальше по этому
   * вердикту решается, ЧЬИ слова уйдут в разбор поведения собеседника:
   * ошибка порога отправляет туда собственные слова человека.
   *
   * Само сходство и порог теперь возвращаются рядом с вердиктом, и
   * отдельным полем сказано, что порог не откалиброван. Это не делает
   * измерение точнее — это перестаёт выдавать его за точное (тот же
   * урок, что в пункте [unmeasured-confidence]). */
  async verifyDetailed(
    userId: string,
    candidateEmbedding: number[],
    threshold: number = DEFAULT_THRESHOLD,
  ): Promise<{ isMatch: boolean | null; similarity: number | null; threshold: number; calibrated: false; reason?: string }> {
    const reference = await this.getReference(userId);
    if (!reference) {
      return { isMatch: null, similarity: null, threshold, calibrated: false, reason: 'Эталон голоса не записан' };
    }
    if (reference.length !== candidateEmbedding.length) {
      // Размерности не совпадают (например, модель сменилась) —
      // честно "не можем сравнить", не бросаем и не гадаем.
      return {
        isMatch: null,
        similarity: null,
        threshold,
        calibrated: false,
        reason: 'Эталон записан другой моделью — сравнивать нечего с чем',
      };
    }
    const similarity = cosineSimilarity(reference, candidateEmbedding);
    // Через общий помощник, а не своим выражением: см. его шапку.
    return { isMatch: isMatch(reference, candidateEmbedding, threshold), similarity, threshold, calibrated: false };
  }

  async hasEnrollment(userId: string): Promise<boolean> {
    const record = await this.prisma.voiceEmbedding.findUnique({ where: { userId } });
    return record !== null;
  }

  async revoke(userId: string) {
    await this.prisma.voiceEmbedding.deleteMany({ where: { userId } });
    await this.consent.revoke(userId, ConsentType.VOICE_BIOMETRIC);
  }
}
