// MVP-фича 11: Центр приватности (§3.47 ТЗ, MVP-пункт 11) —
// "единая точка, откуда пользователь может понять и проконтролировать,
// какие данные о нём и о фигурантах хранятся, без необходимости искать
// настройку внутри каждой отдельной фичи".
//
// ЧЕСТНО про то, чего здесь НЕТ и почему: ТЗ §3.47 перечисляет 6
// секций, две из них физически невозможны на этом проходе —
// "журнал Safe Share" (фича 12, ещё не реализована) и "TTL настройки
// хранения" (RetentionClass как отдельная модель никогда не
// реализовывалась). "Управление персональными данными онбординга —
// вероисповедание, город" тоже отсутствует — это фича §3.24, не входит
// в 13 пунктов MVP. Не выдумываю плейсхолдеры для этих трёх секций —
// экран агрегирует ровно то, что реально существует.
//
// Реальная новая ценность этого прохода — не агрегация сама по себе,
// а deletePerson(): ДО этого прохода PersonsService умел только
// отвязать персону от ОДНОГО проекта (removePerson), не удалить
// данные о человеке по-настоящему, как того требует §3.9 "право на
// удаление данных о себе". Каскад подтверждён на уровне схемы
// (Person.facts/projectLinks/steelmanCases — onDelete: Cascade,
// ConversationScript.person — onDelete: SetNull), не оркестрируется
// вручную в этом сервисе.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrivacyCenterService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(userId: string) {
    const [consents, projectsCount, people] = await Promise.all([
      this.prisma.consentRecord.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.project.count({ where: { ownerId: userId } }),
      this.prisma.person.findMany({
        where: { createdByUserId: userId },
        include: { _count: { select: { facts: true, projectLinks: true } } },
      }),
    ]);

    return {
      consents,
      projectsCount,
      people: people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        factsCount: p._count.facts,
        projectsCount: p._count.projectLinks,
      })),
    };
  }

  /** Полное, необратимое удаление персоны и всех данных о ней —
   * не путать с PersonsService.removePerson(), который только
   * отвязывает персону от ОДНОГО проекта. Закрывает §3.9
   * "право на удаление данных о себе" по-настоящему. */
  async deletePerson(userId: string, personId: string): Promise<void> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, createdByUserId: userId },
    });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    await this.prisma.person.delete({ where: { id: personId } });
  }

  /** Экспорт данных пользователя. Возвращает JSON напрямую, не
   * ссылку на скачивание ({downloadUrl}) — implementation-ready
   * описывал асинхронный джоб с генерацией файла, но это требует
   * файлового хранилища, которого нет в этом MVP-проходе. Осознанное
   * упрощение для объёма данных одного пользователя на старте продукта. */
  async exportData(userId: string) {
    const [projects, people, consents] = await Promise.all([
      this.prisma.project.findMany({
        where: { ownerId: userId },
        include: {
          objective: true,
          boundaries: true,
          arguments: true,
          steelmanCases: true,
          scripts: true,
        },
      }),
      this.prisma.person.findMany({
        where: { createdByUserId: userId },
        include: { facts: true },
      }),
      this.prisma.consentRecord.findMany({ where: { userId } }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      projects,
      people,
      consents,
    };
  }
}
