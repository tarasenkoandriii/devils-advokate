// ContentScanService — оркестрация prompt injection/PII пайплайна
// (§8 ТЗ пп. 18-19, чекпоинт 1 пункт 10 дал только модель данных).
// Закрывает второй TODO, оставленный в AIRouterService.
//
// Правила действия по типу детекта (осознанные, не автоматические):
// - PROMPT_INJECTION → BLOCKED целиком, весь текст. Инъекция отравляет
//   семантику всего промпта, редактировать точечно бессмысленно —
//   либо блокируем весь вызов, либо нет.
// - Высокая уверенность (email/phone/Luhn-валидная карта) → ALIASED —
//   заменяется плейсхолдером в возвращаемом sanitized-тексте.
// - Низкая уверенность (адрес/паспорт-эвристика, confidence < 0.5) →
//   KEPT — НЕ редактируется автоматически. Агрессивная автозамена на
//   основе ненадёжного паттерна рискует испортить легитимный текст
//   сильнее, чем помогает — пользователь/лог видят предупреждение,
//   решение остаётся за вызывающим кодом/пользователем, не за regex'ом.
//
// ContentScanDetection в БД — НИКОГДА raw-значение, только maskedPreview
// (см. правило в схеме, пункт 10 чекпоинта) — это соблюдается здесь
// технически: raw существует только в памяти этой функции, наружу
// (в persist и в возвращаемый результат) уходит только маска.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { detectPII, detectPromptInjection, maskPreview, RawMatch } from './pii-detectors';
import { ScanTargetType, ScanAction, InputScanStatus } from '@prisma/client';

export interface ContentScanRequest {
  text: string;
  targetType: ScanTargetType;
  aiJobId?: string;
  externalRef?: string;
}

export interface ContentScanOutcome {
  blocked: boolean;
  sanitizedText: string;
  resultId: string;
  detectionsCount: number;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.5;

@Injectable()
export class ContentScanService {
  private readonly logger = new Logger(ContentScanService.name);

  constructor(private readonly prisma: PrismaService) {}

  async scan(request: ContentScanRequest): Promise<ContentScanOutcome> {
    const injectionMatches = detectPromptInjection(request.text);

    if (injectionMatches.length > 0) {
      const result = await this.persistResult(request, injectionMatches, 'BLOCKED');
      if (request.aiJobId) {
        await this.prisma.aIJob.update({
          where: { id: request.aiJobId },
          data: { inputScanStatus: InputScanStatus.BLOCKED },
        });
      }
      this.logger.warn(
        `Prompt injection detected (${injectionMatches.length} match(es)) — blocking content, targetType=${request.targetType}`,
      );
      return {
        blocked: true,
        sanitizedText: '',
        resultId: result.id,
        detectionsCount: injectionMatches.length,
      };
    }

    const piiMatches = detectPII(request.text);
    const { sanitizedText, actions } = this.applyActions(request.text, piiMatches);
    const result = await this.persistResult(request, piiMatches, actions);

    if (request.aiJobId) {
      await this.prisma.aIJob.update({
        where: { id: request.aiJobId },
        data: { inputScanStatus: InputScanStatus.PASSED },
      });
    }

    return {
      blocked: false,
      sanitizedText,
      resultId: result.id,
      detectionsCount: piiMatches.length,
    };
  }

  private applyActions(
    text: string,
    matches: RawMatch[],
  ): { sanitizedText: string; actions: Map<RawMatch, ScanAction> } {
    const actions = new Map<RawMatch, ScanAction>();
    const sorted = [...matches].sort((a, b) => b.index - a.index);

    let result = text;
    for (const match of sorted) {
      const action: ScanAction =
        match.confidence >= HIGH_CONFIDENCE_THRESHOLD ? ScanAction.ALIASED : ScanAction.KEPT;
      actions.set(match, action);

      if (action === ScanAction.ALIASED) {
        const placeholder = `[${match.type.replace('PII_', '').toLowerCase()}]`;
        result =
          result.slice(0, match.index) + placeholder + result.slice(match.index + match.raw.length);
      }
    }

    return { sanitizedText: result, actions };
  }

  private async persistResult(
    request: ContentScanRequest,
    matches: RawMatch[],
    forcedAction: 'BLOCKED' | Map<RawMatch, ScanAction>,
  ) {
    const result = await this.prisma.contentScanResult.create({
      data: {
        targetType: request.targetType,
        aiJobId: request.aiJobId,
        externalRef: request.externalRef,
      },
    });

    for (const match of matches) {
      const action: ScanAction =
        forcedAction === 'BLOCKED' ? ScanAction.BLOCKED : forcedAction.get(match) ?? ScanAction.KEPT;

      await this.prisma.contentScanDetection.create({
        data: {
          contentScanResultId: result.id,
          detectionType: match.type,
          action,
          confidence: match.confidence,
          maskedPreview: maskPreview(match.raw),
        },
      });
    }

    return result;
  }
}
