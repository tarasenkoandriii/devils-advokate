// Пункт 24: OpenLoopsService (§3.59 ТЗ) — одиннадцатая и последняя из
// 11 фич MVP v2.
//
// "Логичное продолжение Досье разговора и трекера обязательств (3.49)
// — агрегированная сводка незакрытого по проекту" — тем же классом
// решения, что Evidence Gap (Пункт 17) и Stale Fact Alert (Пункт 22):
// чистая агрегация уже существующих данных, НЕ AI-вызов, НЕ новая
// Prisma-модель. AIRouterModule НЕ импортирован в OpenLoopsModule.
//
// Маппинг четырёх пунктов сводки ТЗ на уже существующие модели
// (обоснование каждого):
// - "неотвеченных вопроса" — ДВА источника вопросов уже существуют в
//   приложении, оба честно включены, не выбран один произвольно:
//   MissingInformationCheck.questions (§3.51, последний снимок по
//   проекту — там нет статуса "отвечен", весь список считается
//   незакрытым) + SourceConflict.clarifyingQuestion с resolvedAt=null
//   по всем фигурантам проекта (§3.56, у этого источника УЖЕ есть
//   явное отслеживание "разрешён/не разрешён" — SourceConflictService.
//   listUnresolvedForProject(), добавлен в этом же чекпоинте).
// - "обязательства (3.49)" — Commitment.status=IN_PROGRESS по проекту,
//   прямая ссылка из самого текста ТЗ на уже реализованную фичу.
// - "решение в ожидании" — Argument.lifecycleStatus=USED: аргумент
//   уже применён в разговоре, но ещё не получил исход (не дошёл до
//   ACCEPTED/REJECTED/COUNTERED) — буквально "решение, ожидающее
//   исхода".
// - "неразрешённое возражение" — Argument.lifecycleStatus=COUNTERED:
//   аргумент был опровергнут собеседником и ещё не получил ответного
//   хода (не ушёл дальше по циклу, например обратно в USED с новой
//   формулировкой) — статус "COUNTERED" и есть открытое возражение.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { CommitmentStatus, ArgumentLifecycleStatus } from '@prisma/client';
import { SourceConflictService } from '../source-conflict/source-conflict.service';

export interface OpenLoopsSummary {
  unansweredQuestionsCount: number;
  openCommitmentsCount: number;
  pendingDecisionsCount: number;
  unresolvedObjectionsCount: number;
  details: {
    missingInformationQuestions: string[];
    unresolvedConflictQuestions: string[];
    openCommitments: Array<{ id: string; description: string }>;
    pendingDecisions: Array<{ id: string; text: string }>;
    unresolvedObjections: Array<{ id: string; text: string }>;
  };
}

@Injectable()
export class OpenLoopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceConflict: SourceConflictService,
  ) {}

  async getSummary(userId: string, projectId: string): Promise<OpenLoopsSummary> {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [latestMissingInfo, unresolvedConflicts, openCommitments, pendingDecisions, unresolvedObjections] =
      await Promise.all([
        this.prisma.missingInformationCheck.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'desc' },
        }),
        this.sourceConflict.listUnresolvedForProject(userId, projectId),
        this.prisma.commitment.findMany({
          where: { projectId, status: CommitmentStatus.IN_PROGRESS },
        }),
        this.prisma.argument.findMany({
          where: { projectId, lifecycleStatus: ArgumentLifecycleStatus.USED },
        }),
        this.prisma.argument.findMany({
          where: { projectId, lifecycleStatus: ArgumentLifecycleStatus.COUNTERED },
        }),
      ]);

    const missingInformationQuestions = latestMissingInfo?.questions ?? [];
    const unresolvedConflictQuestions = unresolvedConflicts.map((c: { clarifyingQuestion: string }) => c.clarifyingQuestion);

    return {
      unansweredQuestionsCount: missingInformationQuestions.length + unresolvedConflictQuestions.length,
      openCommitmentsCount: openCommitments.length,
      pendingDecisionsCount: pendingDecisions.length,
      unresolvedObjectionsCount: unresolvedObjections.length,
      details: {
        missingInformationQuestions,
        unresolvedConflictQuestions,
        openCommitments: openCommitments.map((c: { id: string; description: string }) => ({
          id: c.id,
          description: c.description,
        })),
        pendingDecisions: pendingDecisions.map((a: { id: string; text: string }) => ({ id: a.id, text: a.text })),
        unresolvedObjections: unresolvedObjections.map((a: { id: string; text: string }) => ({
          id: a.id,
          text: a.text,
        })),
      },
    };
  }
}
