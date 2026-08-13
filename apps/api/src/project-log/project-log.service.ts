// Пункт 75: ProjectLogService (§3.39 ТЗ) — "Лог изменений статуса
// проекта с цветовой индикацией", пункт 57 общего списка v4-роадмапа.
// По прямому запросу, разблокировано Пунктом 74 (§3.38).
//
// ВЫЧИСЛЯЕМОЕ ПРЕДСТАВЛЕНИЕ, НЕ НОВАЯ ПЕРСИСТЕНТНАЯ ТАБЛИЦА — лог
// собирается READ-TIME из уже существующих источников (ProjectPerson.
// statusChangedAt, ConversationSignal), не хранится отдельно. Так лог
// физически не может рассинхронизироваться с реальным состоянием —
// нет отдельной копии данных, которую нужно было бы поддерживать в
// актуальном виде.
//
// ЧЕСТНО РЕАЛИЗОВАНЫ ДВА ИЗ ТРЁХ ИСТОЧНИКОВ СОБЫТИЙ, ОПИСАННЫХ В ТЗ:
// (1) смена статуса персона↔фигурант (§3.38, Пункт 74) — реализовано;
// (2) появление флагов противоречий/манипуляций (§3.16/§3.28,
// ConversationSignal.signalType=FACTUAL_DISCREPANCY/MANIPULATION_
// PATTERN, оба уже построены) — реализовано; (3) "пересечение порогов
// индикатора накала" (§3.33) — НЕ реализовано, тот же непостроенный
// live-индикатор, что блокирует пункты 51/52/55, зафиксировано в
// /TODO.md. "Прощупывание" (§3.37, ConversationSignalType.
// PROBING_PATTERN) — enum-значение существует в схеме, но ни один
// сервис никогда не создаёт такие записи (проверено перед началом
// работы), детектор для него не построен — тоже честно не включено.
//
// "СНЯТИЕ" ФЛАГОВ ЧЕСТНО НЕ ОТСЛЕЖИВАЕТСЯ — ConversationSignal.disputed
// существует в схеме, но ни один сервис никогда его не выставляет
// (проверено тем же способом) — лог показывает только ПОЯВЛЕНИЕ
// флагов (🔴), не их снятие (было бы 🟢, если бы механизм существовал).
//
// "ОБЯЗАТЕЛЬНОЕ УПОМИНАНИЕ ПЕРСОНЫ" — buкально ТЗ ("никогда не
// абстрактна... всегда называет конкретного человека"). Сигналы БЕЗ
// привязанной Person (participant.personId === null, диаризация ещё
// не сопоставлена конкретному человеку) ЧЕСТНО ПРОПУСКАЮТСЯ, не
// показываются с выдуманным/обобщённым именем.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationSignalType, PersonStatus } from '@prisma/client';

export type ProjectLogColor = 'GREEN' | 'RED';
export type ProjectLogEventType = 'STATUS_CHANGE' | 'DISCREPANCY_DETECTED' | 'MANIPULATION_DETECTED';

export interface ProjectLogEntry {
  color: ProjectLogColor;
  eventType: ProjectLogEventType;
  personId: string;
  personName: string;
  description: string;
  occurredAt: Date;
  sourceConversationId: string | null;
}

@Injectable()
export class ProjectLogService {
  constructor(private readonly prisma: PrismaService) {}

  async getLog(userId: string, projectId: string): Promise<ProjectLogEntry[]> {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [statusChanges, signals] = await Promise.all([
      this.prisma.projectPerson.findMany({
        where: { projectId, statusChangedAt: { not: null } },
        include: { person: true },
      }),
      this.prisma.conversationSignal.findMany({
        where: {
          signalType: { in: [ConversationSignalType.FACTUAL_DISCREPANCY, ConversationSignalType.MANIPULATION_PATTERN] },
          participant: { conversation: { projectId }, personId: { not: null } },
        },
        include: { participant: { include: { person: true, conversation: true } } },
      }),
    ]);

    const statusEntries: ProjectLogEntry[] = statusChanges.map(
      (link: { personId: string; person: { displayName: string | null }; status: PersonStatus; statusChangedAt: Date | null }) => ({
        color: link.status === PersonStatus.FIGURANT ? 'RED' : 'GREEN',
        eventType: 'STATUS_CHANGE',
        personId: link.personId,
        personName: link.person.displayName ?? 'без имени',
        description:
          link.status === PersonStatus.FIGURANT
            ? `Статус ${link.person.displayName ?? 'без имени'} изменён на «фигурант» — обнаружен конфликт интересов`
            : `Статус ${link.person.displayName ?? 'без имени'} изменён на «персона» — активного конфликта интересов больше нет`,
        occurredAt: link.statusChangedAt!,
        sourceConversationId: null,
      }),
    );

    // Только сигналы с реально привязанной Person — см. обоснование в
    // шапке файла про "обязательное упоминание персоны".
    const signalEntries: ProjectLogEntry[] = signals
      .filter((s: any) => s.participant?.personId)
      .map((s: any) => ({
        color: 'RED', // появление флага — эскалация; "снятие" (было бы 🟢) честно не отслеживается, см. шапку файла
        eventType: s.signalType === ConversationSignalType.FACTUAL_DISCREPANCY ? 'DISCREPANCY_DETECTED' : 'MANIPULATION_DETECTED',
        personId: s.participant.personId,
        personName: s.participant.person.displayName ?? 'без имени',
        description:
          s.signalType === ConversationSignalType.FACTUAL_DISCREPANCY
            ? `Обнаружено расхождение в словах ${s.participant.person.displayName ?? 'без имени'}`
            : `Обнаружена манипулятивная уловка со стороны ${s.participant.person.displayName ?? 'без имени'}`,
        occurredAt: s.createdAt,
        sourceConversationId: s.participant.conversationId,
      }));

    return [...statusEntries, ...signalEntries].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }
}
