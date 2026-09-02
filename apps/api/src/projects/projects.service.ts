// MVP-фича 2: личный кабинет решений + история (§3.2 ТЗ, MVP-пункт 2)
//
// Простой CRUD поверх Project, который уже полностью существует с
// чекпоинта 1 (пункт 1) — здесь не проектируется новая модель данных,
// только сервисный слой с одним принципиальным правилом: КАЖДАЯ
// операция проверяет ownerId === userId, не полагаясь на то, что
// клиент передал "свой" projectId честно. NotFoundException — не
// ForbiddenException — используется единообразно и для "не существует",
// и для "существует, но не ваш", чтобы не давать возможность отличить
// эти два случая снаружи (стандартная практика, тем более уместная
// здесь — весь проект построен вокруг чувствительной приватности).

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalArtifactsCleanupService } from '../common/external-artifacts/external-artifacts-cleanup.service';
import { assertProjectOwnership } from '../common/project-ownership';

export interface CreateProjectInput {
  question: string;
  goal?: string;
}

export interface UpdateProjectInput {
  question?: string;
  goal?: string;
}

export interface ListProjectsOptions {
  take?: number;
  skip?: number;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly externalArtifacts: ExternalArtifactsCleanupService,
  ) {}

  async create(userId: string, input: CreateProjectInput) {
    return this.prisma.project.create({
      data: { ownerId: userId, question: input.question, goal: input.goal },
    });
  }

  async list(userId: string, options: ListProjectsOptions = {}) {
    const take = Math.min(options.take ?? 20, 100); // жёсткий потолок — не даём случайно запросить всё разом
    const skip = options.skip ?? 0;

    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where: { ownerId: userId },
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          question: true,
          goal: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { arguments: true, people: true } },
        },
      }),
      this.prisma.project.count({ where: { ownerId: userId } }),
    ]);

    return { items, total, take, skip };
  }

  /** Детальный вид проекта — "история" в терминах MVP-пункта 2: не
   * только текущее состояние, но аргументы в хронологическом порядке
   * и список причастных персон. Полноценный Open Loops/агрегация
   * незакрытого (§3.59 ТЗ) — отдельная более поздняя фича, здесь —
   * только базовая история, достаточная для MVP. */
  async getDetail(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      include: {
        arguments: { orderBy: { createdAt: 'asc' } },
        people: { include: { person: true } },
        // Пункт 57 — нужно, чтобы TMA знала, отправлен ли уже проект
        // в публичную библиотеку, не дублировать отправку.
        libraryEntry: true,
      },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  async update(userId: string, projectId: string, input: UpdateProjectInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.question !== undefined ? { question: input.question } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
      },
    });
  }

  async remove(userId: string, projectId: string): Promise<void> {
    await assertProjectOwnership(this.prisma, userId, projectId);
    // Аудит 2026-09-02 (продолжение): каскад снимает строки, но не файлы
    // в хранилище (доказательства ДТП, транзитное аудио разговоров) и не
    // задачи распознавания у провайдера. «Удалить всё» обещало всё —
    // теперь внешние артефакты убираются ДО каскада (best-effort: отказ
    // удаления файла не оставляет проект в БД).
    await this.externalArtifacts.discardForProject(projectId);
    await this.prisma.project.delete({ where: { id: projectId } });
  }
}
