// MVP-фича 9: BATNA/WATNA и точка выхода (§3.45 ТЗ, MVP-пункт 9)
//
// Тот же паттерн, что DecisionObjectiveService (фича 6) — 1:1 с
// Project, upsert-семантика, простая форма поверх небольшой таблицы.
// Единственная содержательная логика здесь — не в этом сервисе, а в
// Conversation Card (фича 8), которая читает эти данные как готовую
// проверочную границу.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { assertProjectOwnership } from '../common/project-ownership';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class SaveNegotiationBoundariesInput {
  @IsOptional() @IsString() @MaxLength(4000) idealOutcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) acceptableOutcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) batna?: string;
  @IsOptional() @IsString() @MaxLength(4000) watna?: string;
  @IsOptional() @IsString() @MaxLength(4000) walkAwayPoint?: string;
}

@Injectable()
export class NegotiationBoundariesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.negotiationBoundaries.findUnique({ where: { projectId } });
  }

  async save(userId: string, projectId: string, input: SaveNegotiationBoundariesInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const data = {
      idealOutcome: input.idealOutcome,
      acceptableOutcome: input.acceptableOutcome,
      batna: input.batna,
      watna: input.watna,
      walkAwayPoint: input.walkAwayPoint,
    };

    return this.prisma.negotiationBoundaries.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
  }
}
