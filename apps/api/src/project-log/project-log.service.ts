// Пункт 75: ProjectLogService (§3.39 ТЗ) — "Лог изменений статуса
// проекта с цветовой индикацией", пункт 57 общего списка v4-роадмапа.
// По прямому запросу, разблокировано Пунктом 74 (§3.38).
//
// ВЫЧИСЛЯЕМОЕ ПРЕДСТАВЛЕНИЕ, НЕ НОВАЯ ПЕРСИСТЕНТНАЯ ТАБЛИЦА — лог
// собирается READ-TIME из уже существующих источников (ProjectPerson.
// statusChangedAt, ConversationSignal, EscalationCategoryEvent,
// ProbingTopic), не хранится отдельно. Так лог физически не может
// рассинхронизироваться с реальным состоянием — нет отдельной копии
// данных, которую нужно было бы поддерживать в актуальном виде.
//
// Пункт [project-log-v2] 2026-09-03 — ЗАКРЫТ ТРЕТИЙ ИСТОЧНИК СОБЫТИЙ И
// СНЯТИЕ ФЛАГОВ. До этого пункта лог показывал два источника из трёх и
// только ПОЯВЛЕНИЕ флагов, то есть половину описанной в ТЗ динамики:
// «в какую сторону идёт конфликт» читалось по логу только вверх.
// Теперь:
// (1) смена статуса персона↔фигурант (§3.38) — как было;
// (2) появление флагов расхождений/манипуляций (§3.16/§3.28) — как было;
// (3) пересечение порогов индикатора накала (§3.33) — переход между
//     категориями внутри одной сессии экрана сопровождения: вверх 🔴,
//     вниз 🟢;
// (4) прощупывание (§3.37) — тема, набравшая порог повторов;
// (5) СНЯТИЕ флага человеком (🟢) — ConversationSignal.disputed, который
//     до этого пункта не выставлялся вообще ничем.
//
// «ОБЯЗАТЕЛЬНОЕ УПОМИНАНИЕ ПЕРСОНЫ» — buкально ТЗ («никогда не
// абстрактна... всегда называет конкретного человека»). Событие без
// привязанного человека ЧЕСТНО ПРОПУСКАЕТСЯ, не показывается с
// выдуманным или обобщённым именем. Это касается всех источников
// одинаково: сигнала, чья диаризация ещё не сопоставлена человеку;
// события накала и темы прощупывания, для которых пользователь не
// указал собеседника. Пропуск — не потеря данных: событие остаётся в
// своей таблице и в своих метриках, его просто нечем назвать в логе.
//
// СНЯТЫЙ ФЛАГ НЕ СТИРАЕТ ЗАПИСЬ О ЕГО ПОЯВЛЕНИИ — в логе остаются обе:
// 🔴 «обнаружено» и 🟢 «снято вами». Лог — хронология, а не текущее
// состояние; задним числом переписанная история конфликта хуже, чем
// история с исправлением.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationSignalType, EscalationCategory, PersonStatus } from '@prisma/client';

export type ProjectLogColor = 'GREEN' | 'RED';
export type ProjectLogEventType =
  | 'STATUS_CHANGE'
  | 'DISCREPANCY_DETECTED'
  | 'MANIPULATION_DETECTED'
  | 'FLAG_WITHDRAWN'
  | 'ESCALATION_UP'
  | 'ESCALATION_DOWN'
  | 'PROBING_DETECTED';

export interface ProjectLogEntry {
  color: ProjectLogColor;
  eventType: ProjectLogEventType;
  personId: string;
  personName: string;
  description: string;
  occurredAt: Date;
  sourceConversationId: string | null;
  // Пункт [project-log-v2]: сессия экрана сопровождения, породившая
  // событие накала — «с прямой ссылкой на разговор/сессию», buкально ТЗ.
  sourceSessionId: string | null;
  // Флаг, к которому относится запись: по нему UI даёт человеку снять
  // флаг или вернуть его обратно. Для остальных типов событий — null.
  sourceSignalId: string | null;
}

// Порядок значимости категорий накала. Тот же, что в
// DecisionOutcomeService (§3.34) — дублируется намеренно: там он
// считает «сглаженные конфликты», здесь определяет направление
// перехода, и связывать два разных расчёта одной константой из чужого
// сервиса значило бы, что правка одной метрики молча меняет другую.
const ESCALATION_RANK: Record<EscalationCategory, number> = { CALM: 0, RISING: 1, HIGH: 2, CRITICAL: 3 };
const CATEGORY_LABEL: Record<EscalationCategory, string> = {
  CALM: 'спокойно',
  RISING: 'напряжение растёт',
  HIGH: 'высокий накал',
  CRITICAL: 'риск срыва разговора',
};

// Порог из ProbingDetectorService: одно упоминание темы прощупыванием
// не считается («дважды, трижды» — buкально ТЗ). В лог попадают только
// темы, реально его перешедшие, — иначе лог обвинял бы человека в
// прощупывании за один уточняющий вопрос.
const PROBING_REPEAT_THRESHOLD = 2;

@Injectable()
export class ProjectLogService {
  constructor(private readonly prisma: PrismaService) {}

  async getLog(userId: string, projectId: string): Promise<ProjectLogEntry[]> {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [statusChanges, signals, escalationEvents, probingTopics] = await Promise.all([
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
      this.prisma.escalationCategoryEvent.findMany({
        where: { projectId, personId: { not: null } },
        include: { person: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.probingTopic.findMany({
        where: { projectId, personId: { not: null } },
        include: { person: true },
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
        sourceSessionId: null,
        sourceSignalId: null,
      }),
    );

    // Только сигналы с реально привязанной Person — см. обоснование в
    // шапке файла про "обязательное упоминание персоны".
    const signalEntries: ProjectLogEntry[] = [];
    for (const s of signals as any[]) {
      if (!s.participant?.personId) continue;
      const name = s.participant.person.displayName ?? 'без имени';
      signalEntries.push({
        color: 'RED', // появление флага — эскалация
        eventType: s.signalType === ConversationSignalType.FACTUAL_DISCREPANCY ? 'DISCREPANCY_DETECTED' : 'MANIPULATION_DETECTED',
        personId: s.participant.personId,
        personName: name,
        description:
          s.signalType === ConversationSignalType.FACTUAL_DISCREPANCY
            ? `Обнаружено расхождение в словах ${name}`
            : `Обнаружена манипулятивная уловка со стороны ${name}`,
        occurredAt: s.createdAt,
        sourceConversationId: s.participant.conversationId,
        sourceSessionId: null,
        sourceSignalId: s.id,
      });
      // Снятие флага — отдельная запись, а не замена предыдущей.
      // disputedAt может отсутствовать у флагов, снятых до появления
      // поля: тогда честнее не показывать событие вовсе, чем ставить
      // ему выдуманную дату (createdAt означал бы «снят в момент
      // появления»).
      if (s.disputed && s.disputedAt) {
        signalEntries.push({
          color: 'GREEN',
          eventType: 'FLAG_WITHDRAWN',
          personId: s.participant.personId,
          personName: name,
          description:
            s.signalType === ConversationSignalType.FACTUAL_DISCREPANCY
              ? `Вы сняли флаг расхождения в словах ${name} — по-вашему, расхождения нет`
              : `Вы сняли флаг уловки со стороны ${name} — по-вашему, уловки не было`,
          occurredAt: s.disputedAt,
          sourceConversationId: s.participant.conversationId,
          sourceSessionId: null,
          sourceSignalId: s.id,
        });
      }
    }

    // «Пересечение порогов индикатора накала» — именно ПЕРЕХОД между
    // категориями внутри одной сессии. Первое событие сессии записью не
    // становится: до него состояние неизвестно, и назвать его
    // «пересечением» значило бы придумать точку отсчёта.
    const escalationEntries: ProjectLogEntry[] = [];
    const lastByKey = new Map<string, EscalationCategory>();
    for (const e of escalationEvents as any[]) {
      const key = `${e.sessionId}::${e.personId}`;
      const previous = lastByKey.get(key);
      lastByKey.set(key, e.category);
      if (previous === undefined || ESCALATION_RANK[e.category as EscalationCategory] === ESCALATION_RANK[previous]) continue;
      const up = ESCALATION_RANK[e.category as EscalationCategory] > ESCALATION_RANK[previous];
      const name = e.person?.displayName ?? 'без имени';
      escalationEntries.push({
        color: up ? 'RED' : 'GREEN',
        eventType: up ? 'ESCALATION_UP' : 'ESCALATION_DOWN',
        personId: e.personId,
        personName: name,
        description: up
          ? `Накал в разговоре с ${name} вырос: ${CATEGORY_LABEL[previous]} → ${CATEGORY_LABEL[e.category as EscalationCategory]}`
          : `Накал в разговоре с ${name} снизился: ${CATEGORY_LABEL[previous]} → ${CATEGORY_LABEL[e.category as EscalationCategory]}`,
        occurredAt: e.createdAt,
        sourceConversationId: null,
        sourceSessionId: e.sessionId,
        sourceSignalId: null,
      });
    }

    const probingEntries: ProjectLogEntry[] = (probingTopics as any[])
      .filter((t) => t.personId && t.repeatCount >= PROBING_REPEAT_THRESHOLD)
      .map((t) => ({
        color: 'RED' as const,
        eventType: 'PROBING_DETECTED' as const,
        personId: t.personId,
        personName: t.person?.displayName ?? 'без имени',
        // Тема названа словами самой темы — «прощупывает бюджет на
        // переезд», не «ведёт себя подозрительно».
        description: `${t.person?.displayName ?? 'без имени'} возвращается к теме «${t.topicDescription}» — уже ${t.repeatCount} раз(а)`,
        occurredAt: t.lastDetectedAt,
        sourceConversationId: null,
        sourceSessionId: null,
        sourceSignalId: null,
      }));

    return [...statusEntries, ...signalEntries, ...escalationEntries, ...probingEntries].sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
    );
  }

  /** Пункт [project-log-v2] (§3.39 ТЗ, «появление/снятие флагов»).
   * Снять и вернуть флаг может ТОЛЬКО человек — тот же принцип, что у
   * userConfirmedIntentionalFalsehood (§3.16) и у смены статуса персоны
   * (§3.38): модель предлагает, решение остаётся за пользователем. Ни
   * один сервис не выставляет disputed сам, поэтому и метод один, и
   * вызывается он только из явного действия в интерфейсе. */
  async setFlagDisputed(userId: string, projectId: string, signalId: string, disputed: boolean) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const signal = await this.prisma.conversationSignal.findFirst({
      where: { id: signalId, participant: { conversation: { projectId } } },
    });
    if (!signal) throw new NotFoundException(`ConversationSignal ${signalId} not found in project ${projectId}`);
    return this.prisma.conversationSignal.update({
      where: { id: signalId },
      // Возврат флага стирает дату снятия: иначе в логе осталось бы 🟢
      // «снят» у флага, который снова активен.
      data: { disputed, disputedAt: disputed ? new Date() : null },
    });
  }
}
