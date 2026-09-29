// Пункт [job-domain-v2] Р-3 / Р-9 / К-1 (§6.4, §7.2) — оффер работодателя
// соискателю-пользователю КОПИЕЙ, не ручной вставкой текста.
//
// Работодатель собирает оффер в INTERVIEW-листе кандидата (OfferDocument —
// свой документ; черновик условий даёт offerDraft), нанимающий менеджер
// ревьюит (reviewedAt), и документ уходит соискателю копией — в его
// проект, в его VACANCY_RESPONSE-лист по этой вакансии. Адресат известен
// через самошеринг соискателя (CandidateShare.sourceSheetId — лист, с
// которого он передал CV): это единственная связь «кандидат у работодателя
// → пользователь-соискатель», и она существует только с согласия соискателя.
//
// Р-9 — перед отправкой детерминированная сверка «оффер ↔ обещания на
// собеседовании»: по каждому условию EMPLOYER сравниваются последняя
// подтверждённая позиция из транскрипта и из текста оффера; расхождение
// показывается, отправку не блокирует, пишется в AuditLog (приёмка 23).
//
// Копия у соискателя — его документ: правки у работодателя её не меняют,
// отзыв ставит withdrawnAt, а не удаляет (приёмка 22). Копия НЕ разбирается
// на позиции автоматически: AI-вызов от имени соискателя запускает он сам.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from '../common/unique-violation';
import { shareIsUsable } from '../common/term-validity';
import { ClauseStance, EvidenceKind, ProjectMode, TermsClauseKind, TermsSheetKind, TermsSide, VacancyIntakeSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCounterpartyProjectNotFrozen } from '../project-freeze/assert-not-frozen';
import { AuditLogService } from '../audit-log/audit-log.service';
import { assertInterviewPoolProjectAccess } from '../interview-pool/interview-pool-access';

export const OFFER_COPY_SOURCE_PREFIX = 'employer-offer:';

export interface OfferPromiseDiscrepancy {
  clauseId: string;
  clauseText: string;
  promised: { stance: ClauseStance | null; quote: string | null; evidenceRef: string | null };
  offered: { stance: ClauseStance | null; quote: string | null };
}

@Injectable()
export class OfferExchangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Р-9: условия оффера против позиций EMPLOYER из собеседований. */
  async promisesCheck(userId: string, offerId: string): Promise<{ offerId: string; discrepancies: OfferPromiseDiscrepancy[] }> {
    const { offer, sheet } = await this.getEmployerOffer(userId, offerId);
    const clauses = await this.prisma.termsClause.findMany({
      where: { sheetId: sheet.id, side: TermsSide.EMPLOYER, kind: TermsClauseKind.CONDITION, confirmedAt: { not: null }, rejectedAt: null },
      include: { positions: { where: { bySide: TermsSide.EMPLOYER, confirmedAt: { not: null }, rejectedAt: null }, orderBy: { confirmedAt: 'asc' } } },
    });
    const discrepancies: OfferPromiseDiscrepancy[] = [];
    for (const c of clauses) {
      const promised = [...c.positions].reverse().find((p) => p.evidenceKind === EvidenceKind.TRANSCRIPT_SEGMENT);
      const offered = [...c.positions].reverse().find((p) => p.evidenceKind === EvidenceKind.OFFER_TEXT && p.evidenceRef === offer.id);
      if (!promised || !offered) continue;
      if (promised.stance !== offered.stance || (promised.evidenceQuote && offered.evidenceQuote && promised.evidenceQuote.trim().toLowerCase() !== offered.evidenceQuote.trim().toLowerCase() && offered.stance !== ClauseStance.accepted)) {
        discrepancies.push({
          clauseId: c.id,
          clauseText: c.text,
          promised: { stance: promised.stance, quote: promised.evidenceQuote, evidenceRef: promised.evidenceRef },
          offered: { stance: offered.stance, quote: offered.evidenceQuote },
        });
      }
    }
    return { offerId: offer.id, discrepancies };
  }

  /** Ревью нанимающим менеджером — гейт перед отправкой. */
  async review(userId: string, offerId: string) {
    const { offer } = await this.getEmployerOffer(userId, offerId);
    return this.prisma.offerDocument.update({ where: { id: offer.id }, data: { reviewedAt: new Date() } });
  }

  /** Копия соискателю-пользователю. Адресат — по самошерингу (candidateShareId
   * или его токен). Если вакансии этой компании у соискателя нет — создаётся
   * JobVacancy(EMPLOYER_SHARE) из текста вакансии работодателя и лист. */
  async shareToCandidate(userId: string, offerId: string, dto: { candidateShareId?: string | null; token?: string | null }) {
    const { offer, sheet, project } = await this.getEmployerOffer(userId, offerId);
    if (!offer.reviewedAt) throw new BadRequestException('Оффер не прошёл ревью нанимающего менеджера — reviewedAt обязателен перед отправкой');
    // Пункт [withdraw-no-trace] 2026-09-06: отозванный документ не
    // отправляется повторно — замена делается новым оффером, см.
    // обоснование в withdraw().
    if (offer.withdrawnAt) throw new BadRequestException('Этот оффер отозван — отправить его снова нельзя. Замена делается новым оффером.');
    const share = dto.candidateShareId
      ? await this.prisma.candidateShare.findUnique({ where: { id: dto.candidateShareId } })
      : dto.token
        ? await this.prisma.candidateShare.findUnique({ where: { shareToken: dto.token } })
        : null;
    // Пункт [term-never-ends] 2026-09-06: здесь проверялись источник
    // согласия и отзыв — но НЕ срок. Это единственный из пяти входов по
    // `CandidateShare`, где проверки срока не было: соискатель ставил
    // ссылке срок, а по этому пути после срока в его лист всё равно
    // ложилась копия оффера. Теперь условие одно на все пять и живёт в
    // `common/term-validity.ts`.
    if (!share || share.consentSource !== 'CANDIDATE_SELF' || !shareIsUsable(share)) {
      throw new NotFoundException('Самошеринг соискателя не найден, просрочен или отозван — копию оффера отправить некуда');
    }
    // адресат должен быть кандидатом ЭТОГО проекта работодателя
    const accepted = share.createdCandidateProfileId
      ? await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId: project.id, candidateProfileId: share.createdCandidateProfileId } })
      : null;
    if (!accepted || sheet.pipelineStatusId !== accepted.id) {
      throw new BadRequestException('Этот самошеринг относится к другому кандидату или другой вакансии');
    }

    const candidateSheet = await this.resolveCandidateSheet(share, project.id);
    const check = await this.promisesCheck(userId, offer.id);
    const copy = await this.prisma.offerDocument.create({
      data: {
        sheetId: candidateSheet.id,
        rawText: offer.rawText,
        source: `${OFFER_COPY_SOURCE_PREFIX}${offer.id}`,
        sharedFromProjectId: project.id,
        sharedAt: new Date(),
      },
    });
    // Р-9 / приёмка 23. ИСПРАВЛЕНО АУДИТОМ 2026-09-03: расхождение
    // «обещали на собеседовании ↔ написали в оффере» уходило только в
    // AuditLog — то есть в место, куда пользователь не смотрит. ТЗ требует
    // видеть его В РЕДАКЦИЯХ ПУНКТА, рядом с самими формулировками: там его
    // читают обе стороны, когда спорят, о чём договаривались.
    //
    // Пишем ПОЗИЦИЮ работодателя с опорой на текст оффера — то есть тем же
    // механизмом, что и любое другое изменение позиции: отдельного «журнала
    // расхождений» здесь нет и не нужно. Отправку это не блокирует (ТЗ:
    // «проходит и пишет»): продукт фиксирует факт, а не запрещает его.
    for (const d of check.discrepancies) {
      await this.prisma.clausePosition.create({
        data: {
          clauseId: d.clauseId,
          bySide: TermsSide.EMPLOYER,
          stance: d.offered.stance,
          note: `Расхождение с обещанным на собеседовании: было «${d.promised.quote ?? d.promised.stance ?? '—'}», в оффере «${d.offered.quote ?? d.offered.stance ?? '—'}»`.slice(0, 600),
          evidenceKind: EvidenceKind.OFFER_TEXT,
          evidenceRef: offer.id,
          evidenceQuote: d.offered.quote,
          confirmedAt: new Date(),
        },
      });
    }

    await this.audit.record({
      actorId: userId,
      action: 'offer.shared_to_candidate',
      resource: 'OfferDocument',
      resourceId: offer.id,
      after: { copyId: copy.id, candidateSheetId: candidateSheet.id, discrepancies: check.discrepancies.map((d) => ({ clauseId: d.clauseId, promised: d.promised.stance, offered: d.offered.stance })) },
    });
    return { copy, discrepancies: check.discrepancies, recordedInRevisions: check.discrepancies.length };
  }

  private async resolveCandidateSheet(share: { sourceSheetId: string | null; sharedByUserId: string }, employerProjectId: string) {
    // Аудит заморозки 2026-09-03: копия оффера ложится в проект СОИСКАТЕЛЯ,
    // которого нет в адресе запроса — guard его не видит никогда. В
    // замороженный проект не пишет никто, включая вторую сторону; текст
    // ответа нейтральный, чтобы отправка не стала способом узнать чужой
    // модерационный статус.
    if (share.sourceSheetId) {
      const sheet = await this.prisma.termsSheet.findUnique({ where: { id: share.sourceSheetId } });
      if (sheet && sheet.kind === TermsSheetKind.VACANCY_RESPONSE) {
        await assertCounterpartyProjectNotFrozen(this.prisma, sheet.projectId);
        return sheet;
      }
    }
    // вакансии у соискателя нет — создаём из текста вакансии работодателя
    const candidateProject = await this.prisma.project.findFirst({ where: { ownerId: share.sharedByUserId, mode: ProjectMode.JOB_SEARCH }, orderBy: { createdAt: 'desc' } });
    const config = candidateProject ? await this.prisma.jobSearchConfig.findUnique({ where: { projectId: candidateProject.id } }) : null;
    if (!candidateProject || !config) throw new BadRequestException('У соискателя нет проекта поиска работы — копию отправить некуда');
    await assertCounterpartyProjectNotFrozen(this.prisma, candidateProject.id);
    const posting = await this.prisma.vacancyPosting.findUnique({ where: { projectId: employerProjectId }, include: { revisions: { orderBy: { createdAt: 'desc' } } } });
    const poolConfig = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId: employerProjectId } });
    const rev = posting?.revisions.find((r) => r.reviewedAt) ?? posting?.revisions[0];
    const rawText = rev?.text ?? poolConfig?.extendedDescription ?? '';
    // Пункт [one-of-several-spoke-for-all] 2026-09-25: отсюда реквизиты
    // копируются в проект СОИСКАТЕЛЯ — «вакансия от такой-то компании».
    // Назвать чужую компанию хуже, чем не назвать никакой: соискатель
    // читает это как факт о работодателе. Если компаний в проекте
    // несколько, копировать нечего — вакансия останется без досье, и
    // это честное «не указано», а не выдумка.
    const employerDossiers = await this.prisma.employerDossier.findMany({ where: { projectId: employerProjectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 });
    const dossier = employerDossiers.length === 1 ? employerDossiers[0] : null;
    const vacancy = await this.prisma.jobVacancy.create({
      data: {
        configId: config.id,
        sourceUrl: null,
        siteHost: null,
        rawText: rawText || `Вакансия работодателя: ${poolConfig?.jobTitle ?? ''}`,
        title: poolConfig?.jobTitle || null,
        intakeSource: VacancyIntakeSource.EMPLOYER_SHARE,
      },
    });
    // досье компании у соискателя — своё, копия идентификатора без фактов (§4.8)
    if (dossier) {
      // Пункт [same-answer-either-way] 2026-09-24: `own ?? create` —
      // замысел идемпотентный, а гонка между чтением и вставкой упиралась
      // в `@@unique([projectId, registryCode])`. `upsert` здесь не
      // подходит: ищем по ИЛИ (код реестра или домен), а уникальность
      // только по коду. Поэтому второй приём того же пункта — поймать и
      // перечитать: ответ один и тот же, кто бы ни успел раньше.
      const own = await this.prisma.employerDossier.findFirst({ where: { projectId: candidateProject.id, OR: [{ registryCode: dossier.registryCode ?? '__none__' }, { domain: dossier.domain ?? '__none__' }] } });
      let target = own;
      if (!target) {
        try {
          target = await this.prisma.employerDossier.create({
            data: { projectId: candidateProject.id, legalName: dossier.legalName, registryCode: dossier.registryCode, domain: dossier.domain, jurisdiction: dossier.jurisdiction },
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          target = await this.prisma.employerDossier.findFirstOrThrow({ where: { projectId: candidateProject.id, registryCode: dossier.registryCode } });
        }
      }
      await this.prisma.jobVacancy.update({ where: { id: vacancy.id }, data: { employerDossierId: target.id } });
    }
    return this.prisma.termsSheet.create({
      data: { projectId: candidateProject.id, kind: TermsSheetKind.VACANCY_RESPONSE, vacancyId: vacancy.id, title: poolConfig?.jobTitle || 'Вакансия работодателя' },
    });
  }

  /** Отзыв/замена: копии помечаются withdrawnAt — не удаляются.
   *
   * Пункт [withdraw-no-trace] 2026-09-06 — отзыв помечается И НА
   * ОРИГИНАЛЕ, у того, кто его сделал.
   *
   * ЧТО БЫЛО. `updateMany` помечал только КОПИИ — строки в проекте
   * кандидата. Оригинал оффера в проекте работодателя оставался
   * нетронутым навсегда, а именно его и читает экран работодателя
   * (`sheetsApi.get` по листам своего проекта). Отсюда:
   *
   *  • бейдж оффера после отзыва по-прежнему говорил «передан
   *    кандидату» — у кандидата при этом честно стояло «отозван».
   *    Две стороны читали одно действие по-разному, и неверной была
   *    сторона того, кто действие совершил;
   *  • кнопка «Отозвать» оставалась на месте, и второе нажатие
   *    выглядело ровно как первое: `updateMany` с фильтром
   *    `withdrawnAt: null` помечал ноль копий и молчал об этом;
   *  • кнопка «Передать кандидату» тоже оставалась — отозванный оффер
   *    можно было отправить снова тем же нажатием.
   *
   * Из пяти отзывов, которые есть в продукте (согласие кандидата,
   * согласие пользователя, инвайт команды, инвайт группы, оффер),
   * четыре ставят отметку на строку, которую видит сам отзывающий.
   * Этот был единственным, который её не ставил.
   *
   * ПОМЕТКА НА ОРИГИНАЛЕ ЗАКРЫВАЕТ ПОВТОРНУЮ ОТПРАВКУ — сознательно.
   * Комментарий выше говорит «отзыв/замена», и замена остаётся
   * возможной: работодатель создаёт НОВЫЙ документ оффера. А вот
   * переслать заново тот самый документ, который только что отозвали,
   * — это не замена, а отмена собственного решения без следа: у
   * кандидата остались бы две копии одного текста, одна «отозвана»,
   * другая нет, и понять, какая в силе, было бы не по чему. */
  async withdraw(userId: string, offerId: string) {
    const { offer, project } = await this.getEmployerOffer(userId, offerId);
    if (offer.withdrawnAt) {
      throw new BadRequestException('Этот оффер уже отозван — повторный отзыв ничего не меняет');
    }
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const copies = await tx.offerDocument.updateMany({
        where: { source: `${OFFER_COPY_SOURCE_PREFIX}${offer.id}`, sharedFromProjectId: project.id, withdrawnAt: null },
        data: { withdrawnAt: now },
      });
      await tx.offerDocument.update({ where: { id: offer.id }, data: { withdrawnAt: now } });
      return copies;
    });
    await this.audit.record({ actorId: userId, action: 'offer.withdrawn', resource: 'OfferDocument', resourceId: offer.id, after: { copiesMarked: result.count } });
    // `copiesMarked: 0` — не мелочь и не успех по умолчанию: копии у
    // кандидата может не быть вовсе (проект удалён, отправки не было),
    // и работодатель обязан прочитать это, а не решить, что отзыв
    // дошёл. Текст для человека собирается здесь, а не на экране:
    // экран не должен додумывать смысл нуля.
    return {
      offerId: offer.id,
      withdrawnAt: now,
      copiesMarked: result.count,
      note:
        result.count > 0
          ? `Копий у кандидата помечено отозванными: ${result.count}.`
          : 'Копий у кандидата не нашлось — помечать было нечего. Оффер отмечен отозванным у вас; если копию вы отправляли, кандидат мог удалить свой проект.',
    };
  }

  private async getEmployerOffer(userId: string, offerId: string) {
    const offer = await this.prisma.offerDocument.findUnique({ where: { id: offerId }, include: { sheet: true } });
    if (!offer) throw new NotFoundException(`OfferDocument ${offerId} not found`);
    const project = await assertInterviewPoolProjectAccess(this.prisma, userId, offer.sheet.projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING || offer.sheet.kind !== TermsSheetKind.INTERVIEW) {
      throw new BadRequestException('Отправить копию может только работодатель из листа кандидата');
    }
    return { offer, sheet: offer.sheet, project };
  }
}
