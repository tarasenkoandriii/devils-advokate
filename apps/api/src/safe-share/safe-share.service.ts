// MVP-фича 12: Safe Share (§3.48 ТЗ, MVP-пункт 12) — последняя фича
// MVP v1. Закрывает два реальных пробела разом:
//
// 1. `ContentScanService` умел сканировать под `ScanTargetType.
//    SAFE_SHARE_PREFLIGHT` с самого чекпоинта 1 (пункт 10) — но этот
//    targetType никогда не использовался, только AI_JOB_INPUT.
//    Реальная работа здесь — не написать сканер заново, а наконец
//    подключить уже готовый к правильной точке входа.
// 2. `ShareButton` (фича 4) с самого начала шарил текст аргументов
//    напрямую в Telegram, вообще не проходя через content scan —
//    настоящая дыра в приватности, не гипотетическая: PII, попавшая в
//    текст вопроса/цели пользователя, могла быть эхом отражена в
//    сгенерированных аргументах и уйти наружу без проверки. Закрывается
//    здесь, не отдельным патчем к ShareButton задним числом.
//
// Жёсткое правило: confirm() не может проставить sentAt без реально
// пройденного preflight — проверяется не по флагу на самой записи, а
// по факту существования ContentScanResult с externalRef на неё.

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ScanTargetType } from '@prisma/client';

export interface PreflightInput {
  text: string;
  contentType: string;
  projectId?: string;
}

export interface PreflightResult {
  safeShareActionId: string;
  blocked: boolean;
  sanitizedText: string;
  detectedItemsCount: number;
}

@Injectable()
export class SafeShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contentScan: ContentScanService,
  ) {}

  async preflight(userId: string, input: PreflightInput): Promise<PreflightResult> {
    if (input.projectId) {
      await assertProjectOwnership(this.prisma, userId, input.projectId);
    }

    const action = await this.prisma.safeShareAction.create({
      data: {
        userId,
        projectId: input.projectId ?? null,
        contentType: input.contentType,
        previewShownAt: new Date(),
      },
    });

    const scanOutcome = await this.contentScan.scan({
      text: input.text,
      targetType: ScanTargetType.SAFE_SHARE_PREFLIGHT,
      externalRef: action.id,
    });

    await this.prisma.safeShareAction.update({
      where: { id: action.id },
      data: { detectedItemsCount: scanOutcome.detectionsCount },
    });

    return {
      safeShareActionId: action.id,
      blocked: scanOutcome.blocked,
      sanitizedText: scanOutcome.sanitizedText,
      detectedItemsCount: scanOutcome.detectionsCount,
    };
  }

  async confirm(userId: string, safeShareActionId: string) {
    const action = await this.prisma.safeShareAction.findFirst({
      where: { id: safeShareActionId, userId },
    });
    if (!action) {
      throw new NotFoundException(`Safe share action ${safeShareActionId} not found`);
    }
    if (action.sentAt) {
      throw new BadRequestException('This Safe Share action was already confirmed');
    }

    const scanResult = await this.prisma.contentScanResult.findFirst({
      where: { externalRef: safeShareActionId },
    });
    if (!scanResult) {
      throw new BadRequestException(
        'Cannot confirm without a preceding preflight scan — call /safe-share/preflight first',
      );
    }

    return this.prisma.safeShareAction.update({
      where: { id: safeShareActionId },
      data: { sentAt: new Date() },
    });
  }

  async listLog(userId: string) {
    return this.prisma.safeShareAction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
