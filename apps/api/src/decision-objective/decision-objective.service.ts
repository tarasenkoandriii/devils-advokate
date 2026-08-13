// MVP-фича 6: структурированная цель решения (§3.42 ТЗ, MVP-пункт 6)
//
// 1:1 с Project, upsert-семантика — форма на фронтенде сохраняет
// "что сейчас заполнено", не различая create/update явно, поэтому и
// сервис даёт один метод save(), а не отдельные create()/update().

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';

export interface SaveDecisionObjectiveInput {
  desiredOutcome?: string;
  idealOutcome?: string;
  minimumAcceptableOutcome?: string;
  unacceptableOutcome?: string;
  deadline?: string;
  constraints?: string[];
  nonNegotiables?: string[];
  negotiables?: string[];
  doNotSay?: string[];
}

@Injectable()
export class DecisionObjectiveService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.decisionObjective.findUnique({ where: { projectId } });
  }

  async save(userId: string, projectId: string, input: SaveDecisionObjectiveInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const data = {
      desiredOutcome: input.desiredOutcome,
      idealOutcome: input.idealOutcome,
      minimumAcceptableOutcome: input.minimumAcceptableOutcome,
      unacceptableOutcome: input.unacceptableOutcome,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
      constraints: input.constraints ?? [],
      nonNegotiables: input.nonNegotiables ?? [],
      negotiables: input.negotiables ?? [],
      doNotSay: input.doNotSay ?? [],
    };

    return this.prisma.decisionObjective.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
  }
}
