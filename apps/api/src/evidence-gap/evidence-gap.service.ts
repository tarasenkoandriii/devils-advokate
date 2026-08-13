// Пункт 17: EvidenceGapService (§3.52 ТЗ) — четвёртая из 11 фич MVP v2.
//
// "Прямое развитие уже существующего тегирования источника (3.10) —
// не новый механизм разметки, а агрегированный обзор" — ТЗ прямо
// требует НЕ заводить новую модель/поле. Классификация полностью
// выводится из уже существующих полей: Argument.derivedFromPersonFactId/
// derivedFromInferenceId (пункт 1 чекпоинта), PersonFact.sourceType/
// status/lastVerifiedAt (тоже пункт 1), AIInference.userVerified/
// userDisputed (пункт 6). Никакого нового поля/AI-вызова не требуется —
// classify() детерминированная, не обращается к AIRouterService вообще.
//
// Маппинг категорий на существующие поля (обоснование каждой строки):
// - ИЗВЕСТНО: derivedFromPersonFact, sourceType=PUBLIC_FACT, не
//   DISPUTED/EXPIRED, не устарело — подтверждённый факт из надёжного
//   источника.
// - ПОДКРЕПЛЕНО: derivedFromPersonFact с sourceType=PERSONAL_RECORD
//   (чья-то личная запись — не публично верифицируемый факт, но и не
//   голая догадка) ИЛИ derivedFromInference с userVerified=true
//   (AI-догадка, которую пользователь подтвердил вручную — уже не
//   просто предположение, но и не факт из первоисточника).
// - ПРЕДПОЛАГАЕТСЯ: derivedFromPersonFact с sourceType=USER_GUESS ИЛИ
//   derivedFromInference без userVerified — прямое соответствие
//   существующему обозначению "🟡/⚪ догадка" (§3.10).
// - ПРОТИВОРЕЧИВО: PersonFact.status=DISPUTED ИЛИ
//   AIInference.userDisputed=true.
// - УСТАРЕЛО: PersonFact.status=EXPIRED ИЛИ lastVerifiedAt старше
//   STALE_THRESHOLD_DAYS. Порог (365 дней) — не выдуман здесь: это
//   буквально пример из §3.57 ТЗ ("3 важных факта старше 12 месяцев"),
//   который тоже опирается на это же поле — взят оттуда, не изобретён
//   заново.
// - НЕИЗВЕСТНО: ни derivedFromPersonFactId, ни derivedFromInferenceId
//   не заполнены — голословное утверждение без какого-либо источника
//   вообще, самый явный "разрыв доказательной базы" из всех.
//
// Приоритет проверок для факта: DISPUTED > EXPIRED/устарело >
// sourceType — противоречивость и устаревание перевешивают формальный
// тип источника (даже PUBLIC_FACT, если он оспорен, не "ИЗВЕСТНО").

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { FactSourceType, FactStatus } from '@prisma/client';

export const STALE_THRESHOLD_DAYS = 365; // §3.57 ТЗ — тот же порог, не изобретён заново для этой фичи

export type EvidenceGapCategory = 'KNOWN' | 'SUPPORTED' | 'ASSUMED' | 'UNKNOWN' | 'CONTRADICTORY' | 'STALE';

export interface ClassifiedArgument {
  id: string;
  text: string;
  stance: string;
  category: EvidenceGapCategory;
}

export interface EvidenceGapReport {
  // §3.52 ТЗ: "отдельный явный вопрос к пользователю" — фиксированный
  // текст, не генерируется AI (для этого не нужен AI-вызов — вопрос
  // один и тот же по смыслу для любого проекта, конкретика — в самом
  // списке аргументов категорий ASSUMED/UNKNOWN ниже).
  promptToUser: string;
  breakdown: Record<EvidenceGapCategory, ClassifiedArgument[]>;
}

@Injectable()
export class EvidenceGapService {
  constructor(private readonly prisma: PrismaService) {}

  async analyze(userId: string, projectId: string): Promise<EvidenceGapReport> {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const args = await this.prisma.argument.findMany({
      where: { projectId },
      include: { derivedFromPersonFact: true, derivedFromInference: true },
      orderBy: { createdAt: 'asc' },
    });

    const breakdown: Record<EvidenceGapCategory, ClassifiedArgument[]> = {
      KNOWN: [],
      SUPPORTED: [],
      ASSUMED: [],
      UNKNOWN: [],
      CONTRADICTORY: [],
      STALE: [],
    };

    for (const arg of args) {
      const category = this.classify(arg);
      breakdown[category].push({ id: arg.id, text: arg.text, stance: arg.stance, category });
    }

    return {
      promptToUser: 'Какие ключевые предположения пока не подтверждены?',
      breakdown,
    };
  }

  private classify(arg: {
    derivedFromPersonFact: {
      status: FactStatus;
      sourceType: FactSourceType;
      lastVerifiedAt: Date | null;
      createdAt: Date;
    } | null;
    derivedFromInference: { userVerified: boolean; userDisputed: boolean } | null;
  }): EvidenceGapCategory {
    if (arg.derivedFromPersonFact) {
      const fact = arg.derivedFromPersonFact;
      if (fact.status === FactStatus.DISPUTED) return 'CONTRADICTORY';
      if (fact.status === FactStatus.EXPIRED || this.isStale(fact.lastVerifiedAt ?? fact.createdAt)) {
        return 'STALE';
      }
      if (fact.sourceType === FactSourceType.PUBLIC_FACT) return 'KNOWN';
      if (fact.sourceType === FactSourceType.PERSONAL_RECORD) return 'SUPPORTED';
      return 'ASSUMED'; // USER_GUESS
    }

    if (arg.derivedFromInference) {
      if (arg.derivedFromInference.userDisputed) return 'CONTRADICTORY';
      if (arg.derivedFromInference.userVerified) return 'SUPPORTED';
      return 'ASSUMED';
    }

    return 'UNKNOWN'; // ни факта, ни AI-вывода — голословное утверждение
  }

  private isStale(date: Date): boolean {
    const ageMs = Date.now() - date.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays > STALE_THRESHOLD_DAYS;
  }
}
