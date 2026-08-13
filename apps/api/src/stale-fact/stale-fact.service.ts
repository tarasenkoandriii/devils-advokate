// Пункт 22: StaleFactService (§3.57 ТЗ) — девятая из 11 фич MVP v2.
//
// САМА СПЕЦИФИКАЦИЯ говорит: "хорошо сочетается с нормализованной
// факт-системой (4.2) — у каждого факта уже есть lastVerifiedAt, это
// просто явный UI-слой поверх уже существующего поля" — НЕ AI-фича,
// НЕ новая Prisma-модель, тот же класс решения, что Evidence Gap
// (Пункт 17): чистая детерминированная выборка по уже существующим
// полям. AIRouterModule НЕ импортирован в StaleFactModule — такая же
// пустая зависимость была бы неправильной, как если бы её
// добавили в EvidenceGapModule без причины.
//
// Порог (365 дней, "12 месяцев" в примере ТЗ) — НЕ продублирован
// локальной константой: импортирован STALE_THRESHOLD_DAYS из
// evidence-gap.service.ts, где он уже определён и обоснован именно
// этим примером §3.57. Одно место истины для одного и того же порога,
// используемого двумя разными фичами.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { STALE_THRESHOLD_DAYS } from '../evidence-gap/evidence-gap.service';
import { FactStatus } from '@prisma/client';

export interface StaleFactWarning {
  id: string;
  personId: string;
  personDisplayName: string | null;
  content: string;
  lastVerifiedAt: Date | null;
  ageInDays: number;
}

@Injectable()
export class StaleFactService {
  constructor(private readonly prisma: PrismaService) {}

  /** "Перед подготовкой к разговору" — §3.57 ТЗ. Все устаревшие факты
   * по ВСЕМ фигурантам, связанным с этим проектом разом (тот же
   * принцип агрегации, что DoNotSayService.listForProject() — карточка
   * разговора не знает заранее, с кем именно из фигурантов проекта
   * состоится следующий разговор). */
  async listForProject(userId: string, projectId: string): Promise<StaleFactWarning[]> {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const personLinks = await this.prisma.projectPerson.findMany({
      where: { projectId },
      select: { personId: true, person: { select: { displayName: true } } },
    });
    const personIds = personLinks.map((l: { personId: string }) => l.personId);
    if (personIds.length === 0) return [];

    const facts = await this.prisma.personFact.findMany({
      where: { personId: { in: personIds }, status: { not: FactStatus.EXPIRED } },
    });

    return this.filterAndFormatStale(facts, personLinks);
  }

  /** То же самое, но для одного конкретного фигуранта — используется
   * в PeopleSection.tsx рядом с уже существующими Steelman/Source
   * Conflict, где карточка персоны уже открыта. */
  async listByPerson(userId: string, personId: string): Promise<StaleFactWarning[]> {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) return [];

    const facts = await this.prisma.personFact.findMany({
      where: { personId, status: { not: FactStatus.EXPIRED } },
    });

    return this.filterAndFormatStale(facts, [{ personId, person: { displayName: person.displayName } }]);
  }

  private filterAndFormatStale(
    facts: Array<{ id: string; personId: string; content: string; lastVerifiedAt: Date | null; createdAt: Date }>,
    personLinks: Array<{ personId: string; person: { displayName: string | null } }>,
  ): StaleFactWarning[] {
    const nameByPersonId = new Map<string, string | null>(
      personLinks.map((l): [string, string | null] => [l.personId, l.person.displayName]),
    );

    const now = Date.now();
    return facts
      .map((f) => {
        const referenceDate = f.lastVerifiedAt ?? f.createdAt; // тот же fallback, что уже в EvidenceGapService.classify()
        const ageInDays = Math.floor((now - referenceDate.getTime()) / (1000 * 60 * 60 * 24));
        return {
          id: f.id,
          personId: f.personId,
          personDisplayName: nameByPersonId.get(f.personId) ?? null,
          content: f.content,
          lastVerifiedAt: f.lastVerifiedAt,
          ageInDays,
        };
      })
      .filter((f) => f.ageInDays > STALE_THRESHOLD_DAYS)
      .sort((a, b) => b.ageInDays - a.ageInDays); // самые старые — первыми, ТЗ: "3 важных факта старше 12 месяцев" подразумевает приоритет самых устаревших
  }
}
