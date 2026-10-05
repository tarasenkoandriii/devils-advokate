// MVP-фича 8: Conversation Card (§3.44 ТЗ, MVP-пункт 8)
//
// Ровно то, что описано в ТЗ: "агрегирующая витрина, не хранит
// собственные данные, только ссылки на уже существующие сущности" —
// поэтому здесь НЕТ новой Prisma-модели ConversationCard вообще, только
// сервис, который читает уже существующие DecisionObjective (фича 6),
// NegotiationBoundaries (фича 9), Argument (фича 1), ConversationScript
// (фича 10, закрывает последний пробел — раньше openingScript/
// closingScript были жёстко null, теперь читаются реально).
//
// Пункт 18 (§3.53 ТЗ, "Что не стоит говорить") добавил selfRiskWarnings
// — AI-ДЕТЕКЦИЯ риска из прошлых разговоров (DoNotSayService,
// агрегация по всему проекту), НЕ то же самое, что уже существующее
// поле `doNotSay` ниже (РУЧНОЙ список, который пользователь сам
// вписывает в DecisionObjective при заполнении цели разговора). Два
// разных источника с похожим смыслом — оставлены раздельными полями в
// ответе, не смешаны в одно: у selfRiskWarnings есть привязка к
// конкретной реплике/разговору и AI-обоснование, у doNotSay — нет,
// это просто список фраз пользователя.
//
// ЧЕСТНО про то, чего здесь всё ещё нет: туз в рукаве/план Б
// (флагманская "Досье разговора" из раздела 2 ТЗ — модели данных есть
// с Пункта 12, чтение в карточку сюда ещё не добавлено). Карточка не
// притворяется полной — чего нет, то явно отсутствует в ответе, не
// заполняется плейсхолдером.
//
// Пункт 22 (§3.57 ТЗ, "Предупреждение об устаревших фактах") добавил
// staleFacts — тем же способом, что selfRiskWarnings выше:
// агрегирующий вызов StaleFactService.listForProject(), без AI-вызова
// (в отличие от Do Not Say — эта фича детерминированная, см.
// stale-fact.service.ts).
//
// Пункты 27/28 закрыли последний честно зафиксированный пробел выше —
// agenda (§3.44 ТЗ прямо перечисляет "туз в рукаве и план Б/В" среди
// содержимого карточки разговора, раздел 2) и protectedNotes теперь
// читаются реально, не отсутствуют молча.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationScriptType } from '@prisma/client';
import { DoNotSayService } from '../do-not-say/do-not-say.service';
import { StaleFactService } from '../stale-fact/stale-fact.service';
import { ConversationAgendaService } from '../conversation-agenda/conversation-agenda.service';
import { ProtectedNoteService } from '../protected-note/protected-note.service';
import { partialBasis, shownBasisNote } from '../common/partial-basis';

const TOP_ARGUMENTS_LIMIT = 5;

@Injectable()
export class ConversationCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly doNotSay: DoNotSayService,
    private readonly staleFact: StaleFactService,
    private readonly agenda: ConversationAgendaService,
    private readonly protectedNote: ProtectedNoteService,
  ) {}

  async get(userId: string, projectId: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const [
      objective,
      boundaries,
      topArguments,
      argumentsTotal,
      openingScript,
      closingScript,
      selfRiskWarnings,
      staleFacts,
      latestAgenda,
      protectedNotes,
    ] = await Promise.all([
      this.prisma.decisionObjective.findUnique({ where: { projectId } }),
      this.prisma.negotiationBoundaries.findUnique({ where: { projectId } }),
      this.prisma.argument.findMany({
        where: { projectId },
        orderBy: [{ weight: 'desc' }, { id: 'desc' }],
        take: TOP_ARGUMENTS_LIMIT,
      }),
      // Пункт [shown-not-all] 2026-09-05: сколько их всего. Без этого
      // числа «Ключевые аргументы» на карточке — пять из скольких
      // угодно, и человек уносит пятёрку в разговор как весь свой набор.
      this.prisma.argument.count({ where: { projectId } }),
      this.prisma.conversationScript.findFirst({
        where: { projectId, type: ConversationScriptType.OPENING },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.conversationScript.findFirst({
        where: { projectId, type: ConversationScriptType.CLOSING },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.doNotSay.listForProject(userId, projectId),
      this.staleFact.listForProject(userId, projectId),
      this.agenda.getLatest(userId, projectId),
      this.protectedNote.list(userId, projectId),
    ]);

    return {
      project: { question: project.question, goal: project.goal },
      objective,
      boundaries,
      topArguments,
      // Приписка появляется, только если усечение реально было: у
      // большинства проектов аргументов меньше пяти, и говорить там не о
      // чем (пункт [partial-basis]).
      topArgumentsNote: shownBasisNote([
        partialBasis('аргументы', topArguments.length, argumentsTotal, 'weight'),
      ]),
      doNotSay: objective?.doNotSay ?? [], // ручной список пользователя — см. комментарий в шапке файла
      selfRiskWarnings, // AI-детекция из прошлых разговоров, §3.53/§3.17 — отдельно от doNotSay выше
      staleFacts, // §3.57 — детерминированная выборка по lastVerifiedAt, без AI-вызова
      agenda: latestAgenda?.items ?? [], // §2 ТЗ, "повестка следующего разговора" — AI-сформированная, снимок
      protectedNotes, // §2 ТЗ, "туз в рукаве / план Б" — заполняется пользователем вручную
      openingScript: openingScript?.text ?? null,
      closingScript: closingScript?.text ?? null,
    };
  }
}

