// MVP-фича 6: структурированная цель решения (§3.42 ТЗ, MVP-пункт 6)
//
// 1:1 с Project, upsert-семантика — форма на фронтенде сохраняет
// "что сейчас заполнено", не различая create/update явно, поэтому и
// сервис даёт один метод save(), а не отдельные create()/update().

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { assertProjectOwnership } from '../common/project-ownership';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class SaveDecisionObjectiveInput {
  @IsOptional() @IsString() @MaxLength(4000) desiredOutcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) idealOutcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) minimumAcceptableOutcome?: string;
  @IsOptional() @IsString() @MaxLength(4000) unacceptableOutcome?: string;
  @IsOptional() @IsString() @MaxLength(200) deadline?: string;
  // Массив без потолка — тот же безлимитный текст, только в другой обёртке.
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(1000, { each: true }) constraints?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(1000, { each: true }) nonNegotiables?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(1000, { each: true }) negotiables?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(1000, { each: true }) doNotSay?: string[];
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
