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
import { projectTakesFromOthers, PROJECT_LOSSES_NOTE, PROJECT_NOT_REMOVED_HERE } from './project-deletion-impact';
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

  /** Что удаление проекта заберёт у других — ДО решения.
   *
   * Пункт [project-deletion-took-a-stranger] 2026-09-30: у удаления
   * аккаунта такой предпросмотр есть с 2026-09-26, у проекта не было.
   * Экран удаления проекта при этом сам себе ставил правило «что именно
   * исчезнет — сказано ДО нажатия». */
  async deletionPreview(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return {
      takesFromOthers: await projectTakesFromOthers(this.prisma, projectId),
      takesFromOthersNote: PROJECT_LOSSES_NOTE,
      notRemovedHere: [...PROJECT_NOT_REMOVED_HERE],
    };
  }

  async remove(
    userId: string,
    projectId: string,
  ): Promise<{
    deleted: true;
    notRemovedHere: string[];
    tookFromOthers: Awaited<ReturnType<typeof projectTakesFromOthers>>;
    tookFromOthersNote: string;
  }> {
    await assertProjectOwnership(this.prisma, userId, projectId);
    // Считаем ДО каскада — после него считать нечего. Та же граница, что
    // у удаления аккаунта, и та же единственная сторона возможной
    // ошибки: число может оказаться меньше факта, если кто-то напишет
    // комментарий между подсчётом и удалением.
    const tookFromOthers = await projectTakesFromOthers(this.prisma, projectId);
    // Аудит 2026-09-02 (продолжение): каскад снимает строки, но не файлы
    // в хранилище (доказательства ДТП, транзитное аудио разговоров) и не
    // задачи распознавания у провайдера. «Удалить всё» обещало всё —
    // теперь внешние артефакты убираются ДО каскада (best-effort: отказ
    // удаления файла не оставляет проект в БД).
    await this.externalArtifacts.discardForProject(projectId);
    await this.prisma.project.delete({ where: { id: projectId } });

    // Сверка удаления проекта 2026-09-04: удаление аккаунта честно
    // перечисляет, что переживает удаление, а удаление проекта отвечало
    // молчаливым «готово» — при том что переживает оно немало. Один и
    // тот же продукт, два пути, и только один из них честен.
    //
    // Список короткий и точный: сюда попадает только то, что действительно
    // остаётся, и с причиной. Догадки и «на всякий случай» здесь были бы
    // хуже молчания — человек принимает по этому списку решение, стоит ли
    // ему что-то делать дальше.
    return {
      deleted: true,
      // Что забрало у других — тем же списком, что человек видел до
      // решения. Молчание здесь читалось бы как «ни у кого ничего».
      tookFromOthers,
      tookFromOthersNote: PROJECT_LOSSES_NOTE,
      notRemovedHere: [...PROJECT_NOT_REMOVED_HERE],
    };
  }
}
