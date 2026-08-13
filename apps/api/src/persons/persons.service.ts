// MVP-фича 3: статус персона/фигурант (§3.38 ТЗ, MVP-пункт 3)
//
// ProjectPerson.status/statusConfirmedByUser уже полностью в схеме с
// чекпоинта 1 — здесь только сервисный слой поверх готовой модели.
//
// Ключевое бизнес-правило, ради которого вообще существует
// statusConfirmedByUser (P0 финального аудита ТЗ, §7 implementation-ready
// acceptance-тест §3.7): автоматическое предложение сменить статус на
// FIGURANT (когда появится детектор конфликта целей, §3.18 — не в этом
// MVP) НЕ должно применяться молча. В этом сервисе это выражено так:
// смена статуса с trigger=CONFLICT_DETECTOR_SUGGESTED требует явного
// confirmed=true от вызывающего кода; trigger=MANUAL (единственный
// реально достижимый путь в MVP, детектора ещё нет) применяется сразу,
// это осознанное действие самого пользователя, а не предложение системы.

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { PersonStatus, StatusTrigger } from '@prisma/client';

export interface AddPersonInput {
  existingPersonId?: string;
  displayName?: string;
}

export interface UpdateStatusInput {
  status: PersonStatus;
  trigger: StatusTrigger;
  confirmed?: boolean;
}

@Injectable()
export class PersonsService {
  constructor(private readonly prisma: PrismaService) {}

  async addPerson(userId: string, projectId: string, input: AddPersonInput = {}) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    let personId = input.existingPersonId;

    if (personId) {
      const existing = await this.prisma.person.findFirst({
        where: { id: personId, createdByUserId: userId },
      });
      if (!existing) {
        throw new NotFoundException(`Person ${personId} not found`);
      }
    } else {
      const created = await this.prisma.person.create({
        data: { createdByUserId: userId, displayName: input.displayName },
      });
      personId = created.id;
    }

    return this.prisma.projectPerson.upsert({
      where: { projectId_personId: { projectId, personId } },
      update: {},
      create: {
        projectId,
        personId,
        status: PersonStatus.PERSONA,
        statusTrigger: StatusTrigger.MANUAL,
        statusConfirmedByUser: true,
      },
      include: { person: true },
    });
  }

  async listPeople(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.projectPerson.findMany({
      where: { projectId },
      include: { person: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateStatus(
    userId: string,
    projectId: string,
    personId: string,
    input: UpdateStatusInput,
  ) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const link = await this.prisma.projectPerson.findUnique({
      where: { projectId_personId: { projectId, personId } },
    });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    if (input.trigger === StatusTrigger.CONFLICT_DETECTOR_SUGGESTED && input.confirmed !== true) {
      throw new BadRequestException(
        'Автоматическое предложение смены статуса требует явного подтверждения пользователем (confirmed=true) — статус не изменён.',
      );
    }

    return this.prisma.projectPerson.update({
      where: { projectId_personId: { projectId, personId } },
      data: {
        status: input.status,
        statusTrigger: input.trigger,
        statusChangedAt: new Date(),
        statusConfirmedByUser: input.trigger === StatusTrigger.MANUAL ? true : input.confirmed === true,
      },
      include: { person: true },
    });
  }

  async removePerson(userId: string, projectId: string, personId: string): Promise<void> {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const link = await this.prisma.projectPerson.findUnique({
      where: { projectId_personId: { projectId, personId } },
    });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }
    await this.prisma.projectPerson.delete({
      where: { projectId_personId: { projectId, personId } },
    });
  }
}
