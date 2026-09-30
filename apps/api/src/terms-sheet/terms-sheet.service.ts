// Пункт [job-domain-v2] §4.1 / §6.1 — лист условий: одна таблица на три
// поддомена, три вида листа, ровно одна опора у каждого.
//
//   VACANCY          — условия компании по вакансии; опора — InterviewPoolConfig
//                      (проект агентства или работодателя), один на проект;
//   INTERVIEW        — по кандидату; опора — CandidatePipelineStatus; НАСЛЕДУЕТ
//                      пункты VACANCY-листа через sourceClauseId;
//   VACANCY_RESPONSE — соискателя по чужой вакансии; опора — JobVacancy.
//
// Правила, которые держит сервис (Prisma их не выражает):
//   • ровно одна опора (400), один лист на опору за всё время (409 —
//     закрытый возобновляют, новый не открывают);
//   • kind пункта при импорте (§4.2): критерии соискателя и вопросы
//     анкеты → REQUIREMENT; условия из текста → CONDITION;
//   • позиция без опоры не сохраняется; REQUIREMENT не принимает stance,
//     CONDITION — coverage (400);
//   • редакции — цепочка на (пункт, сторона): supersedesId только на
//     ПОДТВЕРЖДЁННУЮ позицию той же bySide;
//   • единственный автоматический переход статуса — DRAFT → IN_NEGOTIATION
//     при первой подтверждённой позиции; всё остальное — руками.
//
// Никакого агрегированного числа по листу нет ни в БД, ни в ответах API:
// счётчики покрытий вычисляются здесь по категориям и только для экрана.

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ClauseCoverage,
  ClauseStance,
  EvidenceKind,
  ProjectMode,
  TermsClauseKind,
  TermsSheetKind,
  TermsSheetStatus,
  TermsSide,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TermsMatchingService, MAX_EVIDENCE_QUOTE_CHARS, TERMS_PROHIBITIONS } from './terms-matching.service';
import { assertHiringProjectAccess } from './terms-access';
import { TEAM_MODES } from '../interview-pool/interview-pool-access';
import { takeSource } from '../common/source-intake';
import { isUniqueViolation } from '../common/unique-violation';

/** Потолок сохраняемого текста оффера. Был безымянным `20_000` внутри
 * `slice` — потолок без имени нельзя ни назвать человеку, ни проверить
 * тестом. */
export const MAX_OFFER_CHARS = 20_000;

/** Ключи, которых в DTO листа быть не должно (приёмка 10).
 *
 * Пункт [the-rule-lived-only-in-a-test] 2026-09-30: эта константа
 * объявлялась здесь и НЕ ПРИМЕНЯЛАСЬ НИГДЕ в продовом коде —
 * единственным её потребителем была одна спека, проверявшая текст JSON
 * одного листа. Правило существовало, и держало оно ровно тот случай,
 * который уже был написан; новое поле `score` в любом другом ответе
 * домена прошло бы мимо.
 *
 * `assertNoForbiddenSheetKeys` — тот же реестр, применённый в рантайме
 * на выходе. Он БРОСАЕТ, а не фильтрует: ключ с оценкой в ответе — это
 * ошибка разработки, а не состояние человека, и молча вырезать поле
 * значило бы скрыть её. Сообщение человеку при этом нейтральное:
 * внутренняя ошибка, а не «у вас что-то не так». */
export const FORBIDDEN_SHEET_KEYS = ['score', 'rank', 'probability', 'rating', 'verdict'] as const;

/** Проверка выхода: ни на одном уровне ответа нет ключа-оценки.
 * Сравнение по ПОЛНОМУ имени ключа, а не по подстроке: `orderIndex`
 * содержит «order», но оценкой не является, и запрещать по подстроке
 * значило бы выключить половину полей домена. */
export function assertNoForbiddenSheetKeys(dto: unknown, where: string): void {
  const forbidden = new Set<string>(FORBIDDEN_SHEET_KEYS);
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, path));
      return;
    }
    if (!v || typeof v !== 'object' || v instanceof Date) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (forbidden.has(k)) {
        throw new Error(
          `Запрещённый ключ-оценка «${k}» в ответе ${where} (${path || 'корень'}): лист условий не выносит оценок — см. FORBIDDEN_SHEET_KEYS`,
        );
      }
      walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(dto, '');
}

const TERMINAL: ReadonlySet<TermsSheetStatus> = new Set([TermsSheetStatus.AGREED, TermsSheetStatus.DECLINED, TermsSheetStatus.WITHDRAWN]);

/** Пункт [label-is-the-choice] 2026-09-06 — какие переходы статуса
 * СЕЙЧАС примет `setStatus()`.
 *
 * НАЙДЕНО. Экран строил выпадающий список статусов из КАРТЫ ПОДПИСЕЙ
 * (`Object.entries(STATUS_LABEL)`), то есть из справочника для
 * отображения. Карта типизирована `Record<string, string>`, поэтому её
 * не держало ни перечисление, ни правила переходов, и она разошлась с
 * обоими:
 *
 *   • в ней нет `WITHDRAWN` — отозвать лист условий было НЕЛЬЗЯ, хотя
 *     статус существует и сервис считает его терминальным;
 *   • в ней есть `CLOSED`, которого в перечислении нет вовсе —
 *     человек выбирал «закрыт» из меню продукта и получал ошибку
 *     валидации;
 *   • в ней есть `DRAFT`, а `setStatus()` его прямо отвергает — вторая
 *     заведомо неработающая строка меню.
 *
 * Карта выглядела полной, потому что ключей в ней было столько же,
 * сколько значений в перечислении — только не тех. Ровно поэтому никто
 * и не заметил.
 *
 * ПОЧЕМУ СПИСОК СЧИТАЕТ СЕРВЕР. Правила переходов живут здесь. Экран,
 * который повторит их у себя, — второй экземпляр правды, и он однажды
 * разойдётся с первым (тот же довод, что в пунктах [consent-purpose] и
 * [promised-arrival]). Предлагать человеку действие, которое заведомо
 * будет отклонено, — обещание, которого продукт не выполняет. */
export function allowedStatusTransitions(current: TermsSheetStatus): TermsSheetStatus[] {
  // В DRAFT не возвращаются никогда — возобновление это IN_NEGOTIATION.
  const candidates = [
    TermsSheetStatus.IN_NEGOTIATION,
    TermsSheetStatus.AGREED,
    TermsSheetStatus.DECLINED,
    TermsSheetStatus.WITHDRAWN,
  ];
  if (TERMINAL.has(current)) {
    // Закрытый лист сначала возобновляют, потом закрывают снова.
    return [TermsSheetStatus.IN_NEGOTIATION];
  }
  return candidates.filter((s) => s !== current);
}

export interface ClauseWithCurrent {
  id: string;
  side: TermsSide;
  kind: TermsClauseKind;
  text: string;
  category: string | null;
  isRequired: boolean;
  orderIndex: number;
  sourceEvidence: EvidenceKind | null;
  sourceRef: string | null;
  sourceQuote: string | null;
  sourceClauseId: string | null;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  counterpartClauseId: string | null;
  counterpartConfirmedAt: Date | null;
  /** текущая подтверждённая позиция каждой стороны */
  current: { EMPLOYER: PositionDto | null; CANDIDATE: PositionDto | null };
  drafts: PositionDto[];
}

export interface PositionDto {
  id: string;
  bySide: TermsSide;
  coverage: ClauseCoverage | null;
  stance: ClauseStance | null;
  note: string | null;
  evidenceKind: EvidenceKind;
  evidenceRef: string | null;
  evidenceQuote: string | null;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  supersedesId: string | null;
  createdAt: Date;
}

/** Детерминированные счётчики покрытия по категориям — единственные числа
 * в DTO листа, кроме orderIndex. Считаются по подтверждённым позициям. */
/** К-5 «Что уточнить до отклика» — вопросы, не «красные флаги».
 *
 * Разница принципиальная и держится промптом: «в вакансии не назван график»
 * — это вопрос («какой график?»), а «скрывают график, будьте осторожны» —
 * вывод о работодателе, которого продукт не делает. Соискатель отправит эти
 * строки живому человеку: формулировка, подразумевающая обвинение, стоит ему
 * отношений, а не нам — репутации. */
export const CLARIFY_QUESTIONS_TASK_TYPE = 'terms-clarifying-questions';

export const CLARIFY_QUESTIONS_PROMPT =
  'Тебе дан список пунктов листа условий, по которым ВТОРАЯ сторона ещё не высказалась (в вакансии не сказано, на собеседовании не прозвучало). ' +
  'Сформулируй по каждому один нейтральный вопрос, который человек может дословно отправить письмом или задать на собеседовании. ' +
  'Вопрос должен спрашивать факт («как устроено…», «что входит в…», «какой срок…»), а не намекать на проблему и не требовать оправданий. ' +
  'ЗАПРЕЩЕНО: любые предупреждения и «красные флаги», слова «почему вы скрываете», «настораживает», «подозрительно»; ' +
  'оценка работодателя, совет отказаться или соглашаться, предсказание ответа. ' +
  TERMS_PROHIBITIONS +
  ' Ответь СТРОГО валидным JSON вида {"questions": [{"clauseId": string, "question": string}]}. Без пояснений вне JSON.';

export function coverageCounters(clauses: ClauseWithCurrent[]) {
  const byCategory: Record<string, Record<ClauseCoverage, number>> = {};
  const total: Record<ClauseCoverage, number> = { covered: 0, partial: 0, not_covered: 0, unknown: 0 };
  for (const c of clauses) {
    if (c.kind !== TermsClauseKind.REQUIREMENT || c.confirmedAt === null || c.rejectedAt !== null) continue;
    // покрытие требования — позиция ДРУГОЙ стороны
    const other = c.side === TermsSide.EMPLOYER ? c.current.CANDIDATE : c.current.EMPLOYER;
    const cov: ClauseCoverage = other?.coverage ?? ClauseCoverage.unknown;
    const cat = c.category ?? 'other';
    byCategory[cat] ??= { covered: 0, partial: 0, not_covered: 0, unknown: 0 };
    byCategory[cat][cov] += 1;
    total[cov] += 1;
  }
  return { total, byCategory };
}

// Пункт [written-for-the-person-never-delivered] 2026-09-30: здесь
// жила `projectBreakdown` — «проекция позиций в старую форму
// matchBreakdown / criteriaBreakdown, экраны и спеки v1 продолжают
// работать без правок ожиданий (приёмка 8)». Ни один экран и ни одна
// спека её не вызывали: обратная совместимость, написанная и никем не
// использованная. Удалена, а не оставлена «на будущее» — мёртвый код
// в этом проекте уже дважды оказывался ловушкой для следующего
// читателя, который принимал его за работающий путь.

/** Лист уже открыт — ОДИН текст и один `existingSheetId` на все пути.
 *
 * Пункт [check-then-create-2] 2026-09-27: тот же отказ обязан достаться и
 * проигравшему гонку, вместе с идентификатором листа — без него экран не
 * может отправить человека в уже открытый лист, и «уже открыт»
 * превращается в тупик. */
function sheetAlreadyOpen(existingSheetId: string): ConflictException {
  return new ConflictException({
    message: 'Лист по этой вакансии уже открыт — возобновите его, новый не открывается',
    existingSheetId,
  });
}

@Injectable()
export class TermsSheetService {

  /** Создать лист — или, если его успел создать параллельный вызов,
   * отдать ТОТ ЖЕ отказ с идентификатором чужого листа.
   *
   * Пункт [check-then-create-2] 2026-09-27. `upsert` здесь был бы
   * неверен: повтор тут ошибка по замыслу («возобновите открытый, новый
   * не открывается»), и молча отдать человеку чужой лист как свой —
   * хуже, чем отказать. */
  private async createSheetOrPointToExisting(
    data: { projectId: string; kind: TermsSheetKind; configId?: string; vacancyId?: string; title: string },
    key: { configId?: string; vacancyId?: string },
  ) {
    try {
      return await this.prisma.termsSheet.create({ data });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.termsSheet.findFirst({ where: key });
      // Если чужого листа не видно (успели удалить) — пробрасываем
      // исходный отказ: выдумывать идентификатор, которого не видели,
      // нельзя.
      if (!winner) throw err;
      throw sheetAlreadyOpen(winner.id);
    }
  }
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: TermsMatchingService,
    private readonly audit: AuditLogService,
  ) {}

  // ── Открытие листов ──

  /** VACANCY — условия компании по вакансии. Пункты EMPLOYER: вопросы анкеты
   * → REQUIREMENT (детерминированно, подтверждены), поля конфига → CONDITION
   * (подтверждены, источник — конфиг). Бриф добавляет черновики отдельно
   * (ClientBriefService.extract). */
  async openVacancySheet(userId: string, projectId: string) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (!TEAM_MODES.has(project.mode)) {
      throw new BadRequestException('Лист VACANCY открывается только в проекте агентства или работодателя');
    }
    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new BadRequestException('У проекта ещё нет конфига вакансии — сначала онбординг или бриф');
    }
    const existing = await this.prisma.termsSheet.findUnique({ where: { configId: config.id } });
    if (existing) {
      throw sheetAlreadyOpen(existing.id);
    }

    let orderIndex = 0;
    const clauses: Array<Parameters<typeof this.prisma.termsClause.create>[0]['data']> = [];
    const conditions: Array<[string, string | null, string]> = [
      ['оплата', config.salaryRange, `Оплата: ${config.salaryRange}`],
      ['условия', config.workArrangement, `Формат работы: ${config.workArrangement}`],
      ['условия', config.employmentLoad, `Занятость: ${config.employmentLoad}`],
      ['локация', config.officeLocation, `Локация: ${config.officeLocation}`],
      ['условия', config.employmentFormat, `Форма оформления: ${config.employmentFormat}`],
    ];
    // Пункт [check-then-create-2] 2026-09-27: `configId` уникален, и на
    // гонке P2002 отдавал пятисотку вместо ConflictException — а вместе с
    // ней терялся `existingSheetId`, то есть ровно то, чем экран
    // отправляет человека в уже открытый лист. Ответ обязан совпадать
    // независимо от того, кто успел раньше.
    const sheet = await this.createSheetOrPointToExisting(
      { projectId, kind: TermsSheetKind.VACANCY, configId: config.id, title: config.jobTitle || 'Вакансия' },
      { configId: config.id },
    );
    for (const q of config.questions) {
      clauses.push({
        sheetId: sheet.id,
        side: TermsSide.EMPLOYER,
        kind: TermsClauseKind.REQUIREMENT,
        text: q.text,
        category: q.category,
        isRequired: q.isRequired,
        orderIndex: orderIndex++,
        sourceQuestionnaireItemId: q.id,
        confirmedAt: new Date(),
      });
    }
    for (const [category, value, text] of conditions) {
      if (!value) continue;
      clauses.push({
        sheetId: sheet.id,
        side: TermsSide.EMPLOYER,
        kind: TermsClauseKind.CONDITION,
        text,
        category,
        isRequired: false,
        orderIndex: orderIndex++,
        sourceEvidence: EvidenceKind.USER_STATED,
        sourceRef: config.id,
        sourceQuote: String(value).slice(0, MAX_EVIDENCE_QUOTE_CHARS),
        confirmedAt: new Date(),
      });
    }
    for (const data of clauses) await this.prisma.termsClause.create({ data });
    return this.get(userId, sheet.id);
  }

  /** INTERVIEW — по кандидату. Наследует подтверждённые пункты VACANCY-листа
   * (открывает его, если ещё нет); сторона CANDIDATE пуста до первого
   * источника. `silent` — технический вызов из regenerate() (приёмка 8):
   * лист заводится без кнопки. */
  async openForCandidate(userId: string, pipelineStatusId: string, opts: { silent?: boolean } = {}) {
    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { id: pipelineStatusId },
      include: { candidateProfile: { select: { displayName: true } }, project: { select: { id: true, mode: true } } },
    });
    if (!status) throw new NotFoundException(`CandidatePipelineStatus ${pipelineStatusId} not found`);
    await assertHiringProjectAccess(this.prisma, userId, status.projectId);

    const existing = await this.prisma.termsSheet.findUnique({ where: { pipelineStatusId } });
    if (existing) {
      if (opts.silent) return this.get(userId, existing.id);
      throw new ConflictException({ message: 'Лист по этому кандидату уже открыт — возобновите его, новый не открывается', existingSheetId: existing.id });
    }

    const vacancySheet = await this.ensureVacancySheet(userId, status.projectId);
    const inherited = vacancySheet
      ? await this.prisma.termsClause.findMany({
          where: { sheetId: vacancySheet.id, confirmedAt: { not: null }, rejectedAt: null },
          orderBy: { orderIndex: 'asc' },
        })
      : [];

    // Сверка «половины операции» 2026-09-04: лист и унаследованные из
    // вакансии пункты создавались отдельными вызовами. Сбой посреди
    // копирования оставлял лист с ЧАСТЬЮ требований вакансии — и это
    // состояние неотличимо от нормального: повторный вызов находит лист
    // существующим (`silent` возвращает его как есть), а недостающие
    // пункты не появятся уже никогда. То есть собеседование велось бы по
    // укороченному списку условий, и ни один экран не сказал бы, что
    // список неполный. Ровно тот случай, который продукт обязан
    // исключать: пробел не должен выглядеть как результат.
    const sheet = await this.prisma.$transaction(async (tx) => {
      const created = await tx.termsSheet.create({
        data: {
          projectId: status.projectId,
          kind: TermsSheetKind.INTERVIEW,
          pipelineStatusId,
          title: status.candidateProfile.displayName,
        },
      });
      let orderIndex = 0;
      for (const c of inherited) {
        await tx.termsClause.create({
          data: {
            sheetId: created.id,
            side: c.side,
            kind: c.kind,
            text: c.text,
            category: c.category,
            isRequired: c.isRequired,
            orderIndex: orderIndex++,
            sourceClauseId: c.id,
            sourceQuestionnaireItemId: c.sourceQuestionnaireItemId,
            sourceEvidence: c.sourceEvidence,
            sourceRef: c.sourceRef,
            sourceQuote: c.sourceQuote,
            confirmedAt: new Date(),
          },
        });
      }
      return created;
    });
    return this.get(userId, sheet.id);
  }

  /** VACANCY_RESPONSE — соискателя по чужой вакансии. CANDIDATE/REQUIREMENT из
   * критериев (детерминированно, подтверждены — приёмка 1), EMPLOYER из
   * rawText — черновики через движок. Дубль (К-15) — 409 с главной. */
  async openForVacancy(userId: string, vacancyId: string) {
    const vacancy = await this.prisma.jobVacancy.findUnique({
      where: { id: vacancyId },
      include: { config: { include: { project: { select: { id: true, ownerId: true, mode: true } }, criteria: { orderBy: { orderIndex: 'asc' } } } } },
    });
    if (!vacancy || vacancy.config.project.ownerId !== userId || vacancy.config.project.mode !== ProjectMode.JOB_SEARCH) {
      throw new NotFoundException(`JobVacancy ${vacancyId} not found`);
    }
    if (vacancy.duplicateOfId) {
      throw new ConflictException({ message: 'Это дубль другой вакансии — лист открывается на главную', primaryVacancyId: vacancy.duplicateOfId });
    }
    const existing = await this.prisma.termsSheet.findUnique({ where: { vacancyId } });
    if (existing) {
      throw sheetAlreadyOpen(existing.id);
    }
    const projectId = vacancy.config.projectId;
    // Пункт [check-then-create-2] 2026-09-27, то же и по той же причине:
    // здесь уникален `vacancyId`.
    const sheet = await this.createSheetOrPointToExisting(
      { projectId, kind: TermsSheetKind.VACANCY_RESPONSE, vacancyId, title: vacancy.title ?? vacancy.siteHost ?? 'Вакансия' },
      { vacancyId },
    );
    let orderIndex = 0;
    for (const cr of vacancy.config.criteria) {
      await this.prisma.termsClause.create({
        data: {
          sheetId: sheet.id,
          side: TermsSide.CANDIDATE,
          kind: TermsClauseKind.REQUIREMENT, // §4.2: критерий соискателя — требование к работодателю
          text: cr.text,
          category: cr.category,
          isRequired: cr.isRequired, // ровно из критерия; DecisionObjective не трогает (приёмка 1)
          orderIndex: orderIndex++,
          sourceCriterionId: cr.id,
          confirmedAt: new Date(),
        },
      });
    }
    await this.matching.proposeClauses({
      userId,
      projectId,
      sheetId: sheet.id,
      side: TermsSide.EMPLOYER,
      text: vacancy.rawText,
      evidenceKind: EvidenceKind.VACANCY_TEXT,
      evidenceRef: vacancy.id,
      scenario: 'job-search-vacancy-clauses',
    });
    return this.get(userId, sheet.id);
  }

  /** Лист VACANCY проекта, открывая его при необходимости; null — если у
   * проекта нет конфига (агентство до онбординга). */
  async ensureVacancySheet(userId: string, projectId: string) {
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId }, select: { id: true } });
    if (!config) return null;
    const existing = await this.prisma.termsSheet.findUnique({ where: { configId: config.id } });
    if (existing) return existing;
    const opened = await this.openVacancySheet(userId, projectId);
    return this.prisma.termsSheet.findUniqueOrThrow({ where: { id: opened.id } });
  }

  // ── Чтение ──

  async listForProject(userId: string, projectId: string) {
    await assertHiringProjectAccess(this.prisma, userId, projectId);
    return this.prisma.termsSheet.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, kind: true, status: true, title: true, configId: true, pipelineStatusId: true, vacancyId: true, createdAt: true, updatedAt: true },
    });
  }

  async proposeCounterparts(userId: string, sheetId: string) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    // Пункт [failure-looks-empty] 2026-09-05: `outcome` и `note` идут
    // наружу вместе с парами. Оставить здесь одни пары значило бы
    // потерять на границе ровно то различие, ради которого движок его
    // теперь и считает.
    const { pairs, outcome, note } = await this.matching.proposeCounterparts({ userId, projectId: sheet.projectId, sheetId });
    return { pairs, outcome, note, clauses: await this.loadClauses(sheetId) };
  }

  async assertSheetAccess(userId: string, sheetId: string) {
    const sheet = await this.prisma.termsSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) throw new NotFoundException(`TermsSheet ${sheetId} not found`);
    const project = await assertHiringProjectAccess(this.prisma, userId, sheet.projectId);
    return { sheet, project };
  }

  async get(userId: string, sheetId: string) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    const clauses = await this.loadClauses(sheetId);
    const offers = await this.prisma.offerDocument.findMany({ where: { sheetId }, orderBy: { createdAt: 'asc' } });
    const cvVariants = await this.prisma.cvVariant.findMany({ where: { sheetId }, orderBy: { compiledAt: 'desc' }, select: { id: true, lang: true, compiledAt: true, reviewedAt: true } });
    const dto = {
      id: sheet.id,
      projectId: sheet.projectId,
      kind: sheet.kind,
      status: sheet.status,
      // [label-is-the-choice] 2026-09-06: список того, что можно
      // выбрать, приходит с сервера — экран больше не строит его из
      // карты подписей.
      allowedStatuses: allowedStatusTransitions(sheet.status),
      title: sheet.title,
      configId: sheet.configId,
      pipelineStatusId: sheet.pipelineStatusId,
      vacancyId: sheet.vacancyId,
      clauses,
      counters: coverageCounters(clauses),
      offers: await this.markDeletedSources(offers),
      cvVariants,
      createdAt: sheet.createdAt,
      updatedAt: sheet.updatedAt,
    };
    // Проверка НА ВЫХОДЕ, а не только в спеке: `get()` — единственная
    // дверь, через которую лист уходит наружу (все прочие методы
    // возвращают `this.get(...)`), поэтому одного места достаточно, и
    // оно же не даст правилу снова стать декларацией.
    assertNoForbiddenSheetKeys(dto, 'TermsSheetService.get');
    return dto;
  }


  /** Приёмка 25 (аудит 2026-09-03): копия документа переживает удаление
   * аккаунта той стороны, которая её прислала — между проектами разных
   * владельцев нет FK, и каскад через границу не идёт. Но человек должен
   * ПОНИМАТЬ, почему у копии больше нет источника: без пометки она выглядит
   * как обычный оффер, за который кто-то отвечает. Проверка на чтении, а не
   * поле в базе: удаление чужого проекта не должно ходить по нашим строкам. */
  private async markDeletedSources<T extends { sharedFromProjectId: string | null }>(rows: T[]): Promise<Array<T & { sourceDeleted: boolean }>> {
    const ids = [...new Set(rows.map((r) => r.sharedFromProjectId).filter((id): id is string => !!id))];
    const alive = ids.length
      ? new Set((await this.prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((p) => p.id))
      : new Set<string>();
    return rows.map((r) => ({ ...r, sourceDeleted: !!r.sharedFromProjectId && !alive.has(r.sharedFromProjectId) }));
  }

  async loadClauses(sheetId: string): Promise<ClauseWithCurrent[]> {
    const rows = await this.prisma.termsClause.findMany({
      where: { sheetId },
      orderBy: { orderIndex: 'asc' },
      include: { positions: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.map((c) => {
      const current: ClauseWithCurrent['current'] = { EMPLOYER: null, CANDIDATE: null };
      const drafts: PositionDto[] = [];
      for (const p of c.positions) {
        const dto: PositionDto = {
          id: p.id,
          bySide: p.bySide,
          coverage: p.coverage,
          stance: p.stance,
          note: p.note,
          evidenceKind: p.evidenceKind,
          evidenceRef: p.evidenceRef,
          evidenceQuote: p.evidenceQuote,
          confirmedAt: p.confirmedAt,
          rejectedAt: p.rejectedAt,
          supersedesId: p.supersedesId,
          createdAt: p.createdAt,
        };
        if (p.rejectedAt) continue;
        if (p.confirmedAt) current[p.bySide] = dto; // отсортировано по времени — последняя подтверждённая побеждает
        else drafts.push(dto);
      }
      return {
        id: c.id,
        side: c.side,
        kind: c.kind,
        text: c.text,
        category: c.category,
        isRequired: c.isRequired,
        orderIndex: c.orderIndex,
        sourceEvidence: c.sourceEvidence,
        sourceRef: c.sourceRef,
        sourceQuote: c.sourceQuote,
        sourceClauseId: c.sourceClauseId,
        confirmedAt: c.confirmedAt,
        rejectedAt: c.rejectedAt,
        counterpartClauseId: c.counterpartClauseId,
        counterpartConfirmedAt: c.counterpartConfirmedAt,
        current,
        drafts,
      };
    });
  }

  /** Редакции пункта — две цепочки по сторонам в порядке времени (приёмка 6). */
  async revisions(userId: string, sheetId: string, clauseId: string) {
    await this.assertSheetAccess(userId, sheetId);
    const clause = await this.prisma.termsClause.findFirst({ where: { id: clauseId, sheetId } });
    if (!clause) throw new NotFoundException(`TermsClause ${clauseId} not found`);
    const positions = await this.prisma.clausePosition.findMany({
      where: { clauseId, confirmedAt: { not: null }, rejectedAt: null },
      orderBy: { confirmedAt: 'asc' },
    });
    return {
      clause: { id: clause.id, side: clause.side, kind: clause.kind, text: clause.text, sourceQuote: clause.sourceQuote },
      EMPLOYER: positions.filter((p) => p.bySide === TermsSide.EMPLOYER),
      CANDIDATE: positions.filter((p) => p.bySide === TermsSide.CANDIDATE),
    };
  }

  /** Повестка — пункты без позиции другой стороны (unknown) или открытые. */
  async agenda(userId: string, sheetId: string) {
    await this.assertSheetAccess(userId, sheetId);
    const clauses = await this.loadClauses(sheetId);
    return clauses
      .filter((c) => c.confirmedAt !== null && c.rejectedAt === null)
      .filter((c) => {
        const other = c.side === TermsSide.EMPLOYER ? c.current.CANDIDATE : c.current.EMPLOYER;
        if (c.kind === TermsClauseKind.REQUIREMENT) return !other || other.coverage === ClauseCoverage.unknown;
        const own = c.current[c.side];
        return !other || other.stance === ClauseStance.unknown || other.stance === ClauseStance.open || own?.stance === ClauseStance.open;
      })
      .map((c) => ({ clauseId: c.id, side: c.side, kind: c.kind, text: c.text, category: c.category, isRequired: c.isRequired }));
  }

  /** К-5: открытые пункты повестки → нейтральные вопросы для письма или
   * собеседования. Ответ собеседника возвращается сюда обычным путём —
   * `propose()` с текстом переписки, — и становится позицией с цитатой.
   *
   * Вопрос без известного clauseId отбрасывается: «вопрос вообще» не
   * привязан ни к чему в листе, и подтвердить по нему потом нечего. */
  async clarifyingQuestions(userId: string, sheetId: string) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    const open = await this.agenda(userId, sheetId);
    if (open.length === 0) return { sheetId, questions: [], note: 'Открытых пунктов нет — уточнять нечего.' };

    const text = await this.matching.ask({
      userId,
      projectId: sheet.projectId,
      taskType: CLARIFY_QUESTIONS_TASK_TYPE,
      systemPrompt: CLARIFY_QUESTIONS_PROMPT,
      userPrompt: `Пункты без ответа второй стороны:\n${open.map((c) => `[id=${c.clauseId}] (${c.kind}) ${c.text}`).join('\n')}`,
      maxTokens: 1200,
      validateOutput: (t) => {
        try {
          const p = JSON.parse(t);
          return Array.isArray(p?.questions) && p.questions.every((q: unknown) => typeof (q as { clauseId?: unknown })?.clauseId === 'string' && typeof (q as { question?: unknown })?.question === 'string');
        } catch {
          return false;
        }
      },
      fail: 'Не удалось сформулировать вопросы',
    });

    const byId = new Map(open.map((c) => [c.clauseId, c]));
    const seen = new Set<string>();
    const questions = (JSON.parse(text) as { questions: Array<{ clauseId: string; question: string }> }).questions
      .filter((q) => byId.has(q.clauseId) && !seen.has(q.clauseId) && seen.add(q.clauseId) !== undefined)
      .map((q) => ({ clauseId: q.clauseId, clauseText: byId.get(q.clauseId)!.text, question: q.question.trim().slice(0, 500) }));

    return {
      sheetId,
      questions,
      note: 'Это вопросы, а не «красные флаги»: продукт не делает выводов о работодателе. Ответ вставьте через «Сверить с текстом» — он станет позицией с цитатой.',
    };
  }

  // ── Пункты ──

  async addClause(userId: string, sheetId: string, dto: { side: TermsSide; kind: TermsClauseKind; text: string; category?: string | null; isRequired?: boolean }) {
    await this.assertSheetAccess(userId, sheetId);
    if (!dto.text?.trim()) throw new BadRequestException('text не может быть пустым');
    const last = await this.prisma.termsClause.findFirst({ where: { sheetId }, orderBy: { orderIndex: 'desc' }, select: { orderIndex: true } });
    const clause = await this.prisma.termsClause.create({
      data: {
        sheetId,
        side: dto.side,
        kind: dto.kind,
        text: dto.text.trim().slice(0, 500),
        category: dto.category ?? null,
        isRequired: dto.isRequired ?? false,
        orderIndex: (last?.orderIndex ?? -1) + 1,
        sourceEvidence: EvidenceKind.USER_STATED,
        sourceQuote: dto.text.trim().slice(0, MAX_EVIDENCE_QUOTE_CHARS),
        confirmedAt: new Date(), // введён руками — подтверждать нечего
      },
    });
    await this.propagateToInterviewSheets(sheetId, [clause.id]);
    return clause;
  }

  async confirmClauses(userId: string, sheetId: string, clauseIds: string[]) {
    await this.assertSheetAccess(userId, sheetId);
    await this.prisma.termsClause.updateMany({
      where: { id: { in: clauseIds }, sheetId, confirmedAt: null, rejectedAt: null },
      data: { confirmedAt: new Date() },
    });
    await this.propagateToInterviewSheets(sheetId, clauseIds);
    return this.loadClauses(sheetId);
  }

  async rejectClauses(userId: string, sheetId: string, clauseIds: string[]) {
    await this.assertSheetAccess(userId, sheetId);
    await this.prisma.termsClause.updateMany({
      where: { id: { in: clauseIds }, sheetId, confirmedAt: null, rejectedAt: null },
      data: { rejectedAt: new Date() },
    });
    return this.loadClauses(sheetId);
  }

  /** Приёмка 13: подтверждённый пункт VACANCY-листа появляется во всех
   * открытых INTERVIEW-листах проекта. */
  private async propagateToInterviewSheets(sheetId: string, clauseIds: string[]) {
    const sheet = await this.prisma.termsSheet.findUnique({ where: { id: sheetId }, select: { kind: true, projectId: true } });
    if (!sheet || sheet.kind !== TermsSheetKind.VACANCY) return;
    const clauses = await this.prisma.termsClause.findMany({ where: { id: { in: clauseIds }, sheetId, confirmedAt: { not: null }, rejectedAt: null } });
    if (clauses.length === 0) return;
    const interviewSheets = await this.prisma.termsSheet.findMany({
      where: { projectId: sheet.projectId, kind: TermsSheetKind.INTERVIEW, status: { notIn: [TermsSheetStatus.DECLINED, TermsSheetStatus.WITHDRAWN] } },
      select: { id: true },
    });
    for (const is of interviewSheets) {
      const already = new Set(
        (await this.prisma.termsClause.findMany({ where: { sheetId: is.id, sourceClauseId: { in: clauses.map((c) => c.id) } }, select: { sourceClauseId: true } })).map(
          (x) => x.sourceClauseId,
        ),
      );
      const last = await this.prisma.termsClause.findFirst({ where: { sheetId: is.id }, orderBy: { orderIndex: 'desc' }, select: { orderIndex: true } });
      let orderIndex = (last?.orderIndex ?? -1) + 1;
      for (const c of clauses) {
        if (already.has(c.id)) continue;
        await this.prisma.termsClause.create({
          data: {
            sheetId: is.id,
            side: c.side,
            kind: c.kind,
            text: c.text,
            category: c.category,
            isRequired: c.isRequired,
            orderIndex: orderIndex++,
            sourceClauseId: c.id,
            sourceQuestionnaireItemId: c.sourceQuestionnaireItemId,
            sourceEvidence: c.sourceEvidence,
            sourceRef: c.sourceRef,
            sourceQuote: c.sourceQuote,
            confirmedAt: new Date(),
          },
        });
      }
    }
  }

  /** Подтверждение пары «одно условие с двух сторон» человеком. */
  async setCounterpart(userId: string, sheetId: string, clauseId: string, counterpartClauseId: string | null) {
    await this.assertSheetAccess(userId, sheetId);
    const clause = await this.prisma.termsClause.findFirst({ where: { id: clauseId, sheetId } });
    if (!clause) throw new NotFoundException(`TermsClause ${clauseId} not found`);
    if (counterpartClauseId) {
      const other = await this.prisma.termsClause.findFirst({ where: { id: counterpartClauseId, sheetId } });
      if (!other) throw new NotFoundException(`TermsClause ${counterpartClauseId} not found`);
      if (other.side === clause.side) throw new BadRequestException('Пара — это одно условие с ДВУХ сторон; оба пункта одной стороны парой быть не могут');
      const now = new Date();
      await this.prisma.termsClause.update({ where: { id: clause.id }, data: { counterpartClauseId, counterpartConfirmedAt: now } });
      await this.prisma.termsClause.update({ where: { id: other.id }, data: { counterpartClauseId: clause.id, counterpartConfirmedAt: now } });
    } else {
      await this.prisma.termsClause.updateMany({ where: { OR: [{ id: clause.id }, { counterpartClauseId: clause.id }] }, data: { counterpartClauseId: null, counterpartConfirmedAt: null } });
    }
    return this.loadClauses(sheetId);
  }

  // ── Позиции ──

  /** Черновики позиций из источника — через движок. */
  async propose(userId: string, sheetId: string, dto: { evidenceKind: EvidenceKind; evidenceRef?: string | null; text?: string | null; bySide?: TermsSide }) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    const bySide = dto.bySide ?? (dto.evidenceKind === EvidenceKind.VACANCY_TEXT || dto.evidenceKind === EvidenceKind.OFFER_TEXT || dto.evidenceKind === EvidenceKind.CLIENT_BRIEF ? TermsSide.EMPLOYER : TermsSide.CANDIDATE);

    if (dto.evidenceKind === EvidenceKind.TRANSCRIPT_SEGMENT) {
      if (!dto.evidenceRef) throw new BadRequestException('Для транскрипта нужен evidenceRef — id разговора');
      const conversation = await this.prisma.conversation.findFirst({ where: { id: dto.evidenceRef, projectId: sheet.projectId }, select: { id: true } });
      if (!conversation) throw new NotFoundException(`Conversation ${dto.evidenceRef} not found`);
      const segments = await this.prisma.transcriptSegment.findMany({
        where: { transcript: { conversationId: conversation.id } },
        orderBy: { startMs: 'asc' },
        select: { id: true, text: true },
      });
      return this.matching.proposePositions({ userId, projectId: sheet.projectId, sheetId, bySide, input: { segments }, scenario: `${sheet.kind}:transcript` });
    }

    let text = dto.text ?? null;
    let ref = dto.evidenceRef ?? null;
    if (dto.evidenceKind === EvidenceKind.VACANCY_TEXT && sheet.vacancyId) {
      const v = await this.prisma.jobVacancy.findUnique({ where: { id: sheet.vacancyId }, select: { rawText: true } });
      text = v?.rawText ?? text;
      ref = sheet.vacancyId;
    } else if (dto.evidenceKind === EvidenceKind.OFFER_TEXT && ref) {
      const offer = await this.prisma.offerDocument.findFirst({ where: { id: ref, sheetId }, select: { rawText: true } });
      if (!offer) throw new NotFoundException(`OfferDocument ${ref} not found`);
      text = offer.rawText;
    } else if (dto.evidenceKind === EvidenceKind.CLIENT_BRIEF && ref) {
      const brief = await this.prisma.clientBrief.findFirst({ where: { id: ref, projectId: sheet.projectId }, select: { rawText: true } });
      if (!brief) throw new NotFoundException(`ClientBrief ${ref} not found`);
      text = brief.rawText;
    }
    if (!text?.trim()) throw new BadRequestException('Нужен text или evidenceRef источника с текстом');
    return this.matching.proposePositions({
      userId,
      projectId: sheet.projectId,
      sheetId,
      bySide,
      input: { text, evidenceKind: dto.evidenceKind, evidenceRef: ref },
      scenario: `${sheet.kind}:${dto.evidenceKind}`,
    });
  }

  /** Позиция вручную — USER_STATED, цитата обязательна (приёмка 2). */
  async addPosition(
    userId: string,
    sheetId: string,
    dto: { clauseId: string; bySide: TermsSide; coverage?: ClauseCoverage | null; stance?: ClauseStance | null; note?: string | null; evidenceQuote: string },
  ) {
    await this.assertSheetAccess(userId, sheetId);
    const clause = await this.prisma.termsClause.findFirst({ where: { id: dto.clauseId, sheetId, rejectedAt: null } });
    if (!clause) throw new NotFoundException(`TermsClause ${dto.clauseId} not found`);
    if (!dto.evidenceQuote?.trim()) throw new BadRequestException('Позиция без опоры не сохраняется: для USER_STATED обязательна цитата (evidenceQuote)');
    this.assertShape(clause.kind, dto.coverage ?? null, dto.stance ?? null);
    const position = await this.prisma.clausePosition.create({
      data: {
        clauseId: clause.id,
        bySide: dto.bySide,
        coverage: dto.coverage ?? null,
        stance: dto.stance ?? null,
        note: dto.note?.slice(0, 600) ?? null,
        evidenceKind: EvidenceKind.USER_STATED,
        evidenceQuote: dto.evidenceQuote.trim().slice(0, MAX_EVIDENCE_QUOTE_CHARS),
      },
    });
    // введена человеком → сразу подтверждена
    return this.confirmPositions(userId, sheetId, [position.id]);
  }

  private assertShape(kind: TermsClauseKind, coverage: ClauseCoverage | null, stance: ClauseStance | null) {
    if (kind === TermsClauseKind.REQUIREMENT) {
      if (stance !== null) throw new BadRequestException('Пункт REQUIREMENT не принимает stance — у требования есть покрытие');
      if (coverage === null) throw new BadRequestException('Для пункта REQUIREMENT нужен coverage');
    } else {
      if (coverage !== null) throw new BadRequestException('Пункт CONDITION не принимает coverage — у условия есть позиция стороны');
      if (stance === null) throw new BadRequestException('Для пункта CONDITION нужен stance');
    }
  }

  /** Подтверждение черновиков: supersedesId — предыдущая подтверждённая
   * позиция ТОЙ ЖЕ стороны по пункту; единственный автопереход статуса. */
  async confirmPositions(userId: string, sheetId: string, positionIds: string[]) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    const drafts = await this.prisma.clausePosition.findMany({
      where: { id: { in: positionIds }, confirmedAt: null, rejectedAt: null, clause: { sheetId } },
    });
    let confirmedAny = false;
    for (const d of drafts) {
      const prev = await this.prisma.clausePosition.findFirst({
        where: { clauseId: d.clauseId, bySide: d.bySide, confirmedAt: { not: null }, rejectedAt: null },
        orderBy: { confirmedAt: 'desc' },
        select: { id: true },
      });
      await this.prisma.clausePosition.update({
        where: { id: d.id },
        data: { confirmedAt: new Date(), supersedesId: prev?.id ?? null },
      });
      confirmedAny = true;
    }
    if (confirmedAny && sheet.status === TermsSheetStatus.DRAFT) {
      await this.prisma.termsSheet.update({ where: { id: sheetId }, data: { status: TermsSheetStatus.IN_NEGOTIATION } });
    }
    return this.loadClauses(sheetId);
  }

  async rejectPositions(userId: string, sheetId: string, positionIds: string[]) {
    await this.assertSheetAccess(userId, sheetId);
    await this.prisma.clausePosition.updateMany({
      where: { id: { in: positionIds }, confirmedAt: null, rejectedAt: null, clause: { sheetId } },
      data: { rejectedAt: new Date() },
    });
    return this.loadClauses(sheetId);
  }

  // ── Оффер ──

  async addOffer(userId: string, sheetId: string, dto: { rawText: string; source?: string | null }) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    if (!dto.rawText?.trim()) throw new BadRequestException('Текст оффера пуст');
    // Пункт [input-truncated] 2026-09-05: здесь усечений ДВА подряд, и
    // оба молчали. Сначала текст оффера режется при СОХРАНЕНИИ (20 000
    // знаков), потом то, что сохранилось, режется ещё раз при разборе
    // (16 000). Сорокатысячный оффер доходил до модели третью частью, а
    // человек читал список условий как список того, что ему
    // предложили. Первое усечение хуже второго: разбор можно повторить,
    // а хвост документа в базу уже не попал.
    const stored = takeSource(dto.rawText, MAX_OFFER_CHARS);
    const offer = await this.prisma.offerDocument.create({
      data: { sheetId, rawText: stored.text, source: dto.source ?? null },
    });
    // новые условия из оффера — черновики пунктов EMPLOYER/CONDITION; позиции offered — черновики
    const clauseOutcome = await this.matching.proposeClauses({
      userId,
      projectId: sheet.projectId,
      sheetId,
      side: TermsSide.EMPLOYER,
      text: offer.rawText,
      evidenceKind: EvidenceKind.OFFER_TEXT,
      evidenceRef: offer.id,
      scenario: `${sheet.kind}:offer-clauses`,
    });
    const positionOutcome = await this.matching.proposePositions({
      userId,
      projectId: sheet.projectId,
      sheetId,
      bySide: TermsSide.EMPLOYER,
      input: { text: offer.rawText, evidenceKind: EvidenceKind.OFFER_TEXT, evidenceRef: offer.id },
      scenario: `${sheet.kind}:offer-positions`,
    });
    await this.prisma.offerDocument.update({ where: { id: offer.id }, data: { parsedAt: new Date() } });
    // [draft-outcome] 2026-09-04: разбор оффера — место, где промолчать
    // дороже всего: человек решает по этому списку, что ему предложили.
    // Условие оффера, потерянное при разборе, читалось как «в оффере
    // этого нет».
    return {
      offer,
      proposedPositions: positionOutcome.created.length,
      draftSkips: { clauses: clauseOutcome.skipped, positions: positionOutcome.skipped },
      // Оба усечения наружу порознь: «не сохранилось» и «не разобрано» —
      // разные события с разной ценой.
      storedIntake: stored.intake,
      intake: clauseOutcome.intake,
    };
  }

  /** А-1 — детерминированный черновик условий из accepted-позиций:
   * что согласовано, что открыто, что отклонено — с цитатами. */
  async offerDraft(userId: string, sheetId: string) {
    await this.assertSheetAccess(userId, sheetId);
    const clauses = await this.loadClauses(sheetId);
    const lines: string[] = ['Черновик условий (не оффер; правовую форму придаёт работодатель)', ''];
    const agreed: string[] = [];
    const open: string[] = [];
    const declined: string[] = [];
    for (const c of clauses) {
      if (c.confirmedAt === null || c.rejectedAt !== null) continue;
      const own = c.current[c.side];
      const other = c.side === TermsSide.EMPLOYER ? c.current.CANDIDATE : c.current.EMPLOYER;
      const quote = (p: PositionDto | null) => (p?.evidenceQuote ? ` — «${p.evidenceQuote}»` : '');
      if (c.kind === TermsClauseKind.CONDITION) {
        const st = other?.stance ?? own?.stance ?? ClauseStance.unknown;
        if (st === ClauseStance.accepted) agreed.push(`• ${c.text}${quote(other ?? own)}`);
        else if (st === ClauseStance.declined) declined.push(`• ${c.text}${quote(other ?? own)}`);
        else open.push(`• ${c.text} (${st})`);
      } else {
        const cov = other?.coverage ?? ClauseCoverage.unknown;
        if (cov === ClauseCoverage.covered) agreed.push(`• ${c.text}${quote(other)}`);
        else if (cov === ClauseCoverage.not_covered) declined.push(`• ${c.text}${quote(other)}`);
        else open.push(`• ${c.text} (${cov})`);
      }
    }
    lines.push('Согласовано / покрыто:', ...(agreed.length ? agreed : ['— пока ничего']), '');
    lines.push('Открыто:', ...(open.length ? open : ['— нет']), '');
    lines.push('Отклонено / не покрыто:', ...(declined.length ? declined : ['— нет']));
    return { text: lines.join('\n'), agreedCount: agreed.length, openCount: open.length, declinedCount: declined.length };
  }

  // ── Статус ──

  async setStatus(userId: string, sheetId: string, status: TermsSheetStatus) {
    const { sheet } = await this.assertSheetAccess(userId, sheetId);
    if (status === TermsSheetStatus.DRAFT) throw new BadRequestException('Вернуть лист в DRAFT нельзя — используйте IN_NEGOTIATION («возобновить»)');
    if (sheet.status === status) return sheet;
    if (TERMINAL.has(sheet.status) && status !== TermsSheetStatus.IN_NEGOTIATION) {
      throw new BadRequestException('Закрытый лист сначала возобновляют (IN_NEGOTIATION), затем закрывают снова');
    }
    const updated = await this.prisma.termsSheet.update({ where: { id: sheetId }, data: { status } });
    await this.audit.record({
      actorId: userId,
      action: TERMINAL.has(sheet.status) ? 'terms_sheet.reopened' : 'terms_sheet.status',
      resource: 'TermsSheet',
      resourceId: sheetId,
      before: { status: sheet.status },
      after: { status },
    });
    return updated;
  }
}
