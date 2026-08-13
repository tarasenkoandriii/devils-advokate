// Пункт 43: RelationshipService (§3.13 ТЗ) — "первый слой" графа
// связей между фигурантами (по итогам разбора выполнимости пунктов
// 20/23 v3-роадмапа), по прямому решению ограниченный БЕЗОПАСНЫМИ
// источниками данных: ручной ввод + подсказка по совместному участию
// в разговоре. Извлечение из текста реплик (fuzzy name matching —
// риск неверного сопоставления) сознательно отложено на отдельный
// проход, не реализовано здесь.
//
// PERSON_GLOBAL — Relationship не привязана к проекту, тот же принцип,
// что уже применялся к PersonCommunicationTrait (Пункт 39). Ownership
// проверяется напрямую через Person.createdByUserId для ОБЕИХ сторон
// связи — тот же паттерн, что PrivacyCenterService.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FactSourceType, RelationshipDirection, RelationshipType } from '@prisma/client';

@Injectable()
export class RelationshipsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    input: {
      personAId: string;
      personBId: string;
      type: RelationshipType;
      label: string;
      direction: RelationshipDirection;
      strength?: number;
      sourceType: FactSourceType;
    },
  ) {
    if (input.personAId === input.personBId) {
      throw new BadRequestException('personAId и personBId не могут совпадать — связь человека с самим собой не имеет смысла');
    }
    await this.assertOwnedPerson(userId, input.personAId);
    await this.assertOwnedPerson(userId, input.personBId);

    return this.prisma.relationship.create({
      data: {
        personAId: input.personAId,
        personBId: input.personBId,
        type: input.type,
        label: input.label,
        direction: input.direction,
        strength: input.strength ?? null,
        sourceType: input.sourceType,
        createdByUserId: userId,
      },
    });
  }

  /** Все связи, где эта персона участвует любой из сторон (A или B) —
   * не только те, что созданы "от лица" этого конкретного вызова. */
  async listForPerson(userId: string, personId: string) {
    await this.assertOwnedPerson(userId, personId);
    return this.prisma.relationship.findMany({
      where: { OR: [{ personAId: personId }, { personBId: personId }] },
      include: { personA: true, personB: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async delete(userId: string, relationshipId: string) {
    const relationship = await this.prisma.relationship.findUnique({ where: { id: relationshipId } });
    if (!relationship || relationship.createdByUserId !== userId) {
      throw new NotFoundException(`Relationship ${relationshipId} not found`);
    }
    await this.prisma.relationship.delete({ where: { id: relationshipId } });
    return { deleted: true };
  }

  /** Подсказки связей по совместному участию в разговоре — ЧИСТЫЙ
   * детерминированный DB-запрос, не AI-вызов. Два Person были
   * участниками одной диаризованной записи — это факт (наблюдаемое
   * взаимодействие), не догадка, поэтому не требует тега "AI-догадка"
   * и не проходит через AIRouterService вообще. Возвращает только
   * пары, у которых ЕЩЁ НЕТ ни одной существующей Relationship записи
   * (в любом направлении) — не предлагает то, что уже подтверждено.
   * Ничего не создаёт сама — только предлагает, пользователь решает,
   * добавлять ли через create() и с каким конкретно label/type. */
  async suggestFromCoParticipation(userId: string) {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: {
        personId: { not: null },
        isSelf: false,
        conversation: { project: { ownerId: userId } },
      },
      select: { personId: true, conversationId: true },
    });

    // Группируем по разговору → множество personId в нём → все
    // уникальные пары внутри этого множества.
    const byConversation = new Map<string, Set<string>>();
    for (const p of participants) {
      if (!p.personId) continue;
      const set = byConversation.get(p.conversationId) ?? new Set<string>();
      set.add(p.personId);
      byConversation.set(p.conversationId, set);
    }

    const pairCounts = new Map<string, { personAId: string; personBId: string; sharedConversations: number }>();
    for (const personIds of byConversation.values()) {
      const ids = [...personIds];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = [ids[i], ids[j]].sort();
          const key = `${a}:${b}`;
          const existing = pairCounts.get(key);
          if (existing) {
            existing.sharedConversations += 1;
          } else {
            pairCounts.set(key, { personAId: a, personBId: b, sharedConversations: 1 });
          }
        }
      }
    }

    if (pairCounts.size === 0) return [];

    const existingRelationships = await this.prisma.relationship.findMany({
      where: { createdByUserId: userId },
      select: { personAId: true, personBId: true },
    });
    const existingPairs = new Set(
      existingRelationships.map((r: { personAId: string; personBId: string }) => {
        const [a, b] = [r.personAId, r.personBId].sort();
        return `${a}:${b}`;
      }),
    );

    const suggestions = [...pairCounts.values()].filter((pair) => {
      const [a, b] = [pair.personAId, pair.personBId].sort();
      return !existingPairs.has(`${a}:${b}`);
    });
    if (suggestions.length === 0) return [];

    const personIds = [...new Set(suggestions.flatMap((s) => [s.personAId, s.personBId]))];
    const people = await this.prisma.person.findMany({ where: { id: { in: personIds } } });
    const peopleById = new Map(people.map((p: { id: string }) => [p.id, p]));

    return suggestions
      .map((s) => ({ ...s, personA: peopleById.get(s.personAId), personB: peopleById.get(s.personBId) }))
      .sort((a, b) => b.sharedConversations - a.sharedConversations);
  }

  private async assertOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}
