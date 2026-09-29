// ТЗ domain-ui-and-voice-intake §1.4 (фаза F) — операторский read-only
// обзор доменных сценариев, intake-квиза и media-review. Никаких правок
// пользовательских конфигов «за пользователя» — та же дисциплина, что у
// /admin/users. Freeze (единственная планировавшаяся мутация) отложен —
// Freeze реализован позже как ProjectFrozenGuard (см. project-freeze/).
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { pagedList, takeWithProbe } from '../common/page';

export const DOMAIN_MODES: Record<string, ProjectMode> = {
  dtp: ProjectMode.DTP,
  'family-law': ProjectMode.FAMILY_LAW,
  health: ProjectMode.HEALTH,
  'interview-pool': ProjectMode.INTERVIEW_POOL,
  investment: ProjectMode.INVESTMENT,
  'major-purchase': ProjectMode.MAJOR_PURCHASE,
  'job-search': ProjectMode.JOB_SEARCH, // Пункт [job-search] 2026-09-01
  'employer-hiring': ProjectMode.EMPLOYER_HIRING, // Пункт [job-domain-v2] §7
};

/** Пункт [operator-read-the-question] 2026-09-25 — открытие карточки
 * проекта оператором. Имя действия стоит рядом с местом, где пишется, и
 * проверяется сверкой: журнал, который переименовали, — это журнал,
 * который перестал искаться. */
export const OPERATOR_VIEWED_PROJECT = 'admin.project_card.viewed';

const CONFIG_RELATION: Record<ProjectMode, string | null> = {
  STANDARD: null,
  DTP: 'dtpConfig',
  FAMILY_LAW: 'familyLawConfig',
  HEALTH: 'healthConfig',
  INTERVIEW_POOL: 'interviewPoolConfig',
  INVESTMENT: 'investmentConfig',
  MAJOR_PURCHASE: 'majorPurchaseConfig',
  JOB_SEARCH: 'jobSearchConfig', // Пункт [job-search] 2026-09-01
  // Пункт [job-domain-v2]: работодатель переиспользует конфиг пула (§7.1)
  EMPLOYER_HIRING: 'interviewPoolConfig',
};

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminDomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) throw new ForbiddenException('Требуется роль оператора');
  }

  private modeFor(domain: string): ProjectMode {
    const mode = DOMAIN_MODES[domain];
    if (!mode) throw new NotFoundException(`Unknown domain: ${domain}`);
    return mode;
  }

  /** Воронка по доменам: проекты за 7/30 дней и всего, доля дошедших до конфига. */
  async summary(userId: string, now = new Date()) {
    await this.assertOperator(userId);
    const since7 = new Date(now.getTime() - 7 * DAY);
    const since30 = new Date(now.getTime() - 30 * DAY);
    const rows: Array<{ domain: string; mode: ProjectMode; total: number; last7: number; last30: number; withConfig: number; configRate: number | null }> = [];
    for (const [domain, mode] of Object.entries(DOMAIN_MODES)) {
      const relation = CONFIG_RELATION[mode]!;
      const [total, last7, last30, withConfig] = await Promise.all([
        this.prisma.project.count({ where: { mode } }),
        this.prisma.project.count({ where: { mode, createdAt: { gte: since7 } } }),
        this.prisma.project.count({ where: { mode, createdAt: { gte: since30 } } }),
        this.prisma.project.count({ where: { mode, [relation]: { isNot: null } } as any }),
      ]);
      rows.push({ domain, mode, total, last7, last30, withConfig, configRate: total > 0 ? Math.round((withConfig / total) * 100) / 100 : null });
    }
    return rows;
  }

  async listProjects(userId: string, domain: string, options: { take?: number; skip?: number; withConfig?: boolean } = {}) {
    await this.assertOperator(userId);
    const mode = this.modeFor(domain);
    const relation = CONFIG_RELATION[mode]!;
    const take = Math.min(Math.max(options.take ?? 50, 1), 200);
    const skip = Math.max(options.skip ?? 0, 0);
    const where: any = { mode };
    if (options.withConfig !== undefined) where[relation] = options.withConfig ? { isNot: null } : { is: null };
    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        // Пункт [operator-read-the-question] 2026-09-25: здесь стоял
        // `question: true` — СВОИМИ СЛОВАМИ написанная дилемма человека,
        // и список отдавал её для ВСЕХ проектов домена сразу. Список —
        // это навигация: оператору нужно отличить строки друг от друга и
        // увидеть состояние, а не читать, у кого что случилось. Текст
        // остался в карточке, где открытие записывается в журнал.
        select: { id: true, createdAt: true, updatedAt: true, frozenAt: true, owner: { select: { id: true, telegramId: true } }, [relation]: { select: { id: true, createdAt: true } }, _count: { select: { conversations: true } } } as any,
      }),
      this.prisma.project.count({ where }),
    ]);
    return {
      items: (items as any[]).map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        frozenAt: p.frozenAt ?? null,
        owner: p.owner,
        config: p[relation] ?? null,
        conversations: p._count?.conversations ?? 0,
      })),
      total, take, skip,
    };
  }

  /** Read-only карточка: проект + конфиг домена как есть (без вложенных
   * доказательств/документов — их содержимое операторам не нужно). */
  async getProject(userId: string, domain: string, projectId: string) {
    await this.assertOperator(userId);
    const mode = this.modeFor(domain);
    const relation = CONFIG_RELATION[mode]!;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, mode },
      select: { id: true, question: true, goal: true, createdAt: true, updatedAt: true, frozenAt: true, frozenNote: true, owner: { select: { id: true, telegramId: true, isRestricted: true, isBlocked: true } }, [relation]: true, _count: { select: { conversations: true } } } as any,
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found in ${domain}`);
    const { [relation]: config, ...rest } = project as any;

    // Пункт [operator-read-the-question] 2026-09-25: в карточке оператор
    // читает СЛОВА ЧЕЛОВЕКА — вопрос, цель, описание цели домена (у
    // здоровья и семейного права это самое личное, что есть в
    // продукте). Доступ у оператора нужен: без него нельзя разобрать
    // жалобу и заморозить проект. Но доступ без следа — это доступ, о
    // котором нельзя честно рассказать. Запись делается ДО ответа и в
    // ней нет самого текста: журнал фиксирует, что карточку открыли, а
    // не повторяет содержимое ещё раз.
    await this.auditLog.record({
      actorId: userId,
      action: OPERATOR_VIEWED_PROJECT,
      resource: 'Project',
      resourceId: projectId,
      after: { domain, ownerId: (rest as { owner?: { id?: string } }).owner?.id ?? null },
    });

    return { ...rest, config, operatorViewLogged: true };
  }

  /** Отчёт по intake-квизу: статусы + матрица «предложил × выбрал». */
  async intakeSummary(userId: string, now = new Date()) {
    await this.assertOperator(userId);
    const since30 = new Date(now.getTime() - 30 * DAY);
    const sessions = await this.prisma.intakeSession.findMany({
      where: { createdAt: { gte: since30 } },
      select: { status: true, suggestedScenario: true, chosenScenario: true, confidence: true, answers: true },
    });
    const byStatus: Record<string, number> = {};
    const matrix: Record<string, Record<string, number>> = {};
    let confidenceSum = 0; let confidenceN = 0; let followUpsSum = 0;
    let mismatches = 0; let dispatched = 0;
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      if (typeof s.confidence === 'number') { confidenceSum += s.confidence; confidenceN++; }
      followUpsSum += ((s.answers as any[]) ?? []).filter((a) => a?.question).length;
      if (s.status === 'DISPATCHED' && s.chosenScenario) {
        dispatched++;
        const sug = s.suggestedScenario ?? 'UNIVERSAL';
        matrix[sug] = matrix[sug] ?? {};
        matrix[sug][s.chosenScenario] = (matrix[sug][s.chosenScenario] ?? 0) + 1;
        if (sug !== s.chosenScenario) mismatches++;
      }
    }
    return {
      windowDays: 30,
      total: sessions.length,
      byStatus,
      dispatched,
      mismatches,
      mismatchRate: dispatched > 0 ? Math.round((mismatches / dispatched) * 100) / 100 : null,
      avgConfidence: confidenceN > 0 ? Math.round((confidenceSum / confidenceN) * 100) / 100 : null,
      avgFollowUps: sessions.length > 0 ? Math.round((followUpsSum / sessions.length) * 100) / 100 : null,
      suggestedVsChosen: matrix,
    };
  }

  /** Очереди media-review со статусами элементов; PROCESSING старше суток —
   * кандидат на «застрял» (класс бага, закрытый аудитом 2026-08-30 §2).
   *
   * Пункт [ceiling-hid-inside-a-total] 2026-09-24. Здесь стоял потолок
   * `take: 200` без слова о себе, и это было хуже обрезанного списка:
   * экран администратора не показывает очереди по одной, он СКЛАДЫВАЕТ
   * их в итоги — «очередей», «роликов», «доля разобранных». Итог по
   * срезу, подписанный как итог по всему, — уверенно показанное число,
   * которое неверно: при девятистах очередях оператор читал «200» и
   * долю среди последних двухсот.
   *
   * Поэтому итоги теперь считает БАЗА по всем строкам, а список
   * остаётся с потолком и говорит о нём (`hasMore`). «Застрявшие»
   * считаются по всем элементам в работе, а не по показанному срезу:
   * множество PROCESSING по самой своей природе невелико, а вопрос
   * «что застряло» не имеет смысла в границах страницы. */
  async mediaReviewQueues(userId: string, now = new Date()) {
    await this.assertOperator(userId);
    const [rows, queuesTotal, itemsByStatus, processingItems] = await Promise.all([
      this.prisma.mediaReviewQueue.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: takeWithProbe(),
        select: { id: true, title: true, createdAt: true, user: { select: { telegramId: true } }, items: { select: { status: true, createdAt: true, conversation: { select: { updatedAt: true } } } } },
      }),
      this.prisma.mediaReviewQueue.count(),
      this.prisma.mediaReviewQueueItem.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.mediaReviewQueueItem.findMany({
        where: { status: 'PROCESSING' },
        select: { createdAt: true, conversation: { select: { updatedAt: true } } },
      }),
    ]);

    const staleCutoff = now.getTime() - DAY;
    const isStuck = (it: { createdAt: Date; conversation: { updatedAt: Date } | null }) =>
      // у элемента нет updatedAt — считаем от последнего изменения привязанной записи, иначе от создания
      (it.conversation?.updatedAt ?? it.createdAt).getTime() < staleCutoff;

    const page = pagedList(rows);
    const queues = page.items.map((q) => {
      const byStatus: Record<string, number> = {};
      let stuck = 0;
      for (const it of q.items) {
        byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
        if (it.status === 'PROCESSING' && isStuck(it)) stuck++;
      }
      return { id: q.id, title: q.title, createdAt: q.createdAt, ownerTelegramId: q.user.telegramId, totalItems: q.items.length, byStatus, stuckProcessing: stuck };
    });

    const totalsByStatus: Record<string, number> = {};
    let itemsTotal = 0;
    for (const g of itemsByStatus) {
      const n = g._count._all;
      totalsByStatus[g.status] = n;
      itemsTotal += n;
    }

    return {
      queues,
      hasMore: page.hasMore,
      limit: page.limit,
      // Итоги — по ВСЕМ строкам базы, а не по показанному срезу.
      totals: {
        queues: queuesTotal,
        items: itemsTotal,
        byStatus: totalsByStatus,
        stuckProcessing: processingItems.filter(isStuck).length,
      },
    };
  }

  /** Единственная мутация операторской панели. Принуждение — ProjectFrozenGuard
   * на мутирующих роутах доменных контроллеров; здесь только флаг + AuditLog. */
  async setFrozen(operatorUserId: string, domain: string, projectId: string, frozen: boolean, note?: string) {
    await this.assertOperator(operatorUserId);
    const mode = this.modeFor(domain);
    const before = await this.prisma.project.findFirst({ where: { id: projectId, mode }, select: { frozenAt: true, frozenNote: true, frozenById: true } });
    if (!before) throw new NotFoundException(`Project ${projectId} not found in ${domain}`);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: frozen ? { frozenAt: new Date(), frozenNote: note?.trim() || null, frozenById: operatorUserId } : { frozenAt: null, frozenNote: null, frozenById: null },
      select: { id: true, frozenAt: true, frozenNote: true, frozenById: true },
    });
    await this.auditLog.record({
      actorId: operatorUserId,
      action: frozen ? 'project.frozen' : 'project.unfrozen',
      resource: 'Project',
      resourceId: projectId,
      before,
      after: { frozenAt: updated.frozenAt, frozenNote: updated.frozenNote, frozenById: updated.frozenById },
    });
    return updated;
  }
}
