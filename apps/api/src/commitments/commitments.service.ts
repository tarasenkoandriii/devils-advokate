// Пункт 14: CommitmentsService (§3.49 ТЗ) — первая из 11 фич MVP v2
// поверх Conversation Dossier.
//
// "Просрочено" — НЕ хранится как статус, вычисляется на чтении
// (dueDate < now && status=IN_PROGRESS) в withComputedFields() ниже.
// См. обоснование в schema.prisma над моделью Commitment: заводить
// статус, для смены которого нужна фоновая cron-джоба (которой в
// проекте нет), было бы преждевременной инфраструктурой.
//
// Напоминания (§3.20, планировщик) — НЕ реализованы, инфраструктуры
// push-уведомлений в проекте не существует вообще. См. тот же
// комментарий в schema.prisma.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { CommitmentOwner, CommitmentStatus } from '@prisma/client';

export interface CreateCommitmentInput {
  personId: string;
  owner: CommitmentOwner;
  description: string;
  dueDate?: string;
  extractedFromConversationId?: string;
  extractedFromSegmentId?: string;
}

export interface UpdateCommitmentInput {
  description?: string;
  dueDate?: string | null;
  status?: CommitmentStatus;
}

@Injectable()
export class CommitmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, projectId: string, input: CreateCommitmentInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    await this.assertPersonOwnership(userId, input.personId);

    const commitment = await this.prisma.commitment.create({
      data: {
        projectId,
        personId: input.personId,
        owner: input.owner,
        description: input.description,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        extractedFromConversationId: input.extractedFromConversationId ?? null,
        extractedFromSegmentId: input.extractedFromSegmentId ?? null,
      },
    });
    return this.withComputedFields(commitment);
  }

  /** Список обязательств по проекту — как своих, так и фигурантов
   * этого конкретного проекта. */
  async listByProject(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const commitments = await this.prisma.commitment.findMany({
      where: { projectId },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
    return commitments.map((c) => this.withComputedFields(c));
  }

  /** §3.49 ТЗ: "отображается в хронологии по фигуранту" — обязательства
   * ПО ЭТОМУ ЧЕЛОВЕКУ сразу по ВСЕМ проектам, где он фигурирует, не
   * только по одному текущему проекту. Отдельный метод от
   * listByProject(), не параметр — семантически разные запросы (один
   * "что должны в этом проекте", другой "что вообще должны этому
   * человеку за всё время отношений"), тот же принцип разделения, что
   * уже применялся к ProjectLogEntry/AuditLogEntry (разная аудитория,
   * не унифицировать ради унификации). */
  async listByPerson(userId: string, personId: string) {
    await this.assertPersonOwnership(userId, personId);
    const commitments = await this.prisma.commitment.findMany({
      where: { personId },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
    return commitments.map((c) => this.withComputedFields(c));
  }

  async update(userId: string, commitmentId: string, input: UpdateCommitmentInput) {
    const existing = await this.findOwnedCommitment(userId, commitmentId);

    const data: Record<string, unknown> = {};
    if (input.description !== undefined) data.description = input.description;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (input.status !== undefined) {
      data.status = input.status;
      // completedAt отражает факт и момент завершения — проставляется/
      // снимается вместе со статусом, не отдельным вызовом (иначе легко
      // получить status=COMPLETED с completedAt=null или наоборот).
      data.completedAt = input.status === CommitmentStatus.COMPLETED ? new Date() : null;
    }

    const updated = await this.prisma.commitment.update({
      where: { id: existing.id },
      data,
    });
    return this.withComputedFields(updated);
  }

  private async findOwnedCommitment(userId: string, commitmentId: string) {
    const commitment = await this.prisma.commitment.findUnique({
      where: { id: commitmentId },
      include: { project: true },
    });
    if (!commitment || commitment.project.ownerId !== userId) {
      throw new NotFoundException(`Commitment ${commitmentId} not found`);
    }
    return commitment;
  }

  private async assertPersonOwnership(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, createdByUserId: userId },
    });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }

  private withComputedFields<T extends { dueDate: Date | null; status: CommitmentStatus }>(
    commitment: T,
  ): T & { isOverdue: boolean } {
    const isOverdue =
      commitment.status === CommitmentStatus.IN_PROGRESS &&
      commitment.dueDate !== null &&
      commitment.dueDate.getTime() < Date.now();
    return { ...commitment, isOverdue };
  }
}
