// Пункт [job-domain-v2] К-8 / А-6 (§3.3, §7.2, §13.2) — самошеринг: соискатель
// сам передаёт CV-вариант и отмеченные пункты листа агентству или
// работодателю-пользователю. Первая точка, где стороны одного договора
// встречаются в продукте.
//
// Согласие = акт передачи с текстом версии CONSENT_TEXT_VERSION: продукт
// проверяет и тип (CANDIDATE_DATA_TRANSFER), и версию, и ребро (purposes:
// to_agency | to_employer) — первая передача по каждому ребру требует
// свежей записи ConsentRecord, старая запись типа без версии не
// засчитывается (приёмка 26). consentSource = CANDIDATE_SELF возможен
// только из проекта JOB_SEARCH — по построению (маршрут в job-search).
//
// Уходит РОВНО: cvText варианта и пункты из visibleClauseIds с их текущими
// позициями (цитаты); ни одного поля транскриптов и репетиций (приёмка 28).
// Получатель принимает как CandidateProfile с sharedFromProjectId и
// acceptedIntoMode; отзыв соискателем ставит revokedAt шеринга и
// consentRevokedAt созданного профиля — получатель видит «отозвано»,
// новые снимки и отчёты профиль не включают (приёмка 27).

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { revokeConsentCascade } from '../interview-pool/consent-revocation';
import { shareIsUsable, termIsCurrent, TERM_OVER_MESSAGE } from '../common/term-validity';
import { CandidateConsentSource, ConsentType, ProjectMode, TermsSheetKind } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CANDIDATE_REVOCATION_EFFECTS, revocationAlsoDone, revocationDoesNotUndo } from '../interview-pool/revocation-report';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { assertInterviewPoolProjectAccess, TEAM_MODES } from '../interview-pool/interview-pool-access';
import { assertProjectNotFrozen } from '../project-freeze/assert-not-frozen';
import { buildStartDeepLink } from '../common/telegram-deep-link';

export const CONSENT_TEXT_VERSION = 'v3';
export const SELF_SHARE_TTL_MS = 72 * 60 * 60 * 1000;
export type ShareEdge = 'to_agency' | 'to_employer';

export const CONSENT_TEXT_V3 =
  'Я передаю получателю (агентству или работодателю, пользующемуся продуктом) свой CV-вариант и отмеченные мной пункты листа условий. ' +
  'Получатель хранит копию в своём проекте для собственного процесса подбора; я могу отозвать согласие в любой момент — копия помечается отозванной и исключается из новой обработки, ' +
  'записи получателя о его процессе остаются. Транскрипты, репетиции и другие мои данные не передаются.';

@Injectable()
export class CandidateSelfShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly sheets: TermsSheetService,
  ) {}

  /** Текст согласия и версия — для экрана перед первой передачей. */
  consentText() {
    return { version: CONSENT_TEXT_VERSION, text: CONSENT_TEXT_V3 };
  }

  async create(
    userId: string,
    sheetId: string,
    dto: { cvVariantId: string; visibleClauseIds: string[]; edge: ShareEdge; consentVersion?: string | null; expiresAt?: string | Date | null },
  ) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (project.mode !== ProjectMode.JOB_SEARCH || sheet.kind !== TermsSheetKind.VACANCY_RESPONSE) {
      throw new BadRequestException('Самошеринг — только из листа соискателя');
    }
    if (dto.edge !== 'to_agency' && dto.edge !== 'to_employer') throw new BadRequestException('Поле edge должно быть to_agency или to_employer');
    const variant = await this.prisma.cvVariant.findFirst({ where: { id: dto.cvVariantId, sheetId } });
    if (!variant) throw new NotFoundException(`CvVariant ${dto.cvVariantId} not found in this sheet`);
    const clauses = await this.prisma.termsClause.findMany({ where: { id: { in: dto.visibleClauseIds }, sheetId }, select: { id: true } });
    if (clauses.length !== new Set(dto.visibleClauseIds).size) throw new BadRequestException('visibleClauseIds — только пункты этого листа');

    // согласие: свежая запись v3 по этому ребру, иначе — акт передачи с consentVersion = v3
    const existing = await this.prisma.consentRecord.findFirst({
      where: { userId, consentType: ConsentType.CANDIDATE_DATA_TRANSFER, version: CONSENT_TEXT_VERSION, granted: true, revokedAt: null, purposes: { has: dto.edge } },
    });
    if (!existing) {
      if (dto.consentVersion !== CONSENT_TEXT_VERSION) {
        throw new ForbiddenException({ message: 'Первая передача по этому ребру требует согласия по тексту версии v3 — передайте consentVersion: "v3" после прочтения', code: 'CONSENT_REQUIRED', consent: this.consentText() });
      }
      await this.prisma.consentRecord.create({
        data: { userId, consentType: ConsentType.CANDIDATE_DATA_TRANSFER, version: CONSENT_TEXT_VERSION, source: 'candidate-self-share', purposes: [dto.edge], projectId: project.id, granted: true, grantedAt: new Date() },
      });
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : new Date(Date.now() + SELF_SHARE_TTL_MS);
    const shareToken = randomBytes(24).toString('base64url');
    const share = await this.prisma.candidateShare.create({
      data: {
        sourceCandidateId: null,
        sourceCvVariantId: variant.id,
        sourceSheetId: sheetId,
        visibleClauseIds: clauses.map((c) => c.id),
        sharedByUserId: userId,
        shareToken,
        expiresAt,
        candidateConsentConfirmed: true,
        consentSource: CandidateConsentSource.CANDIDATE_SELF,
        consentTextVersion: CONSENT_TEXT_VERSION,
      },
    });
    return { shareId: share.id, deepLink: buildStartDeepLink(`share_${shareToken}`), expiresAt, edge: dto.edge };
  }

  async listMine(userId: string, sheetId: string) {
    await this.sheets.assertSheetAccess(userId, sheetId);
    return this.prisma.candidateShare.findMany({
      where: { sourceSheetId: sheetId, sharedByUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, expiresAt: true, acceptedAt: true, acceptedIntoMode: true, revokedAt: true, visibleClauseIds: true, sourceCvVariantId: true, createdAt: true },
    });
  }

  /** Отзыв соискателем: шеринг → revokedAt, созданная копия → consentRevokedAt. */
  async revoke(userId: string, shareId: string) {
    const share = await this.prisma.candidateShare.findFirst({ where: { id: shareId, sharedByUserId: userId, consentSource: CandidateConsentSource.CANDIDATE_SELF } });
    if (!share) throw new NotFoundException(`CandidateShare ${shareId} not found`);
    const now = new Date();
    await this.prisma.candidateShare.update({ where: { id: share.id }, data: { revokedAt: now } });
    // Пункт [copy-outlived-consent] 2026-09-24: здесь копия гасилась с
    // самого начала — и правильно, — но ровно ОДНА, прямая. Принявший
    // копию владеет ею и может поделиться дальше; копия копии
    // оставалась в работе. Дорога теперь общая с рекрутерским отзывом и
    // транзитивная.
    let cascade = { profilesRevoked: 0, sharesRevoked: 0, depthExhausted: false };
    if (share.createdCandidateProfileId) {
      cascade = await revokeConsentCascade(this.prisma, share.createdCandidateProfileId, now);
    }
    await this.audit.record({ actorId: userId, action: 'candidate_self_share.revoked', resource: 'CandidateShare', resourceId: share.id, after: { copiesRevoked: cascade.profilesRevoked, depthExhausted: cascade.depthExhausted } });
    // Пункт [the-outcome-reached-one-route-of-three] 2026-10-01: здесь
    // отдавались ТОЛЬКО числа и НИ ОДНОГО слова человеку. Экран их
    // выбрасывал (`run(() => selfShareApi.revoke(...), reload)`), и
    // единственной обратной связью оставалось слово «отозвано» в строке
    // списка. То есть на маршруте, где человек распоряжается СВОИМИ
    // данными, продукт молча показывал «готово» в том числе тогда, когда
    // цепочка передач оказалась длиннее, чем он проходит за раз.
    const outcome = {
      sharesRevoked: cascade.sharesRevoked,
      copiesRevoked: cascade.profilesRevoked,
      depthExhausted: cascade.depthExhausted,
    };
    return {
      shareId: share.id,
      revokedAt: now,
      copiesRevoked: cascade.profilesRevoked,
      depthExhausted: cascade.depthExhausted,
      alsoDone: revocationAlsoDone(outcome),
      doesNotUndo: revocationDoesNotUndo(outcome, CANDIDATE_REVOCATION_EFFECTS.doesNotUndo),
    };
  }

  /** Публичное превью по токену — только то, что явно передано. */
  async preview(token: string) {
    const share = await this.prisma.candidateShare.findUnique({ where: { shareToken: token } });
    // [term-never-ends] 2026-09-06: условие было переписано здесь
    // вручную — как и в трёх соседних местах, и в пятом его забыли.
    if (!share || share.consentSource !== CandidateConsentSource.CANDIDATE_SELF || !shareIsUsable(share)) {
      throw new NotFoundException(TERM_OVER_MESSAGE);
    }
    // Пункт [letters-were-not-the-language] 2026-09-24: в ответ уходил
    // и `sourceProjectId` — идентификатор ЧАСТНОГО проекта соискателя,
    // получателю ссылки не нужный и ни одним экраном не используемый.
    // Он нужен только `accept`, внутри. Тот же класс, что убранный
    // ссылкой на частный проект в публичной библиотеке; правило о
    // выдаче полей его не видит, потому что ответ собирается руками.
    const { sourceProjectId: _internal, ...payload } = await this.buildPayload(share);
    return { shareId: share.id, expiresAt: share.expiresAt, accepted: !!share.acceptedAt, ...payload };
  }

  /** Принять агентством или работодателем в свой проект. */
  async accept(userId: string, dto: { token: string; projectId: string }) {
    const share = await this.prisma.candidateShare.findUnique({ where: { shareToken: dto.token } });
    // Здесь отзыв НАМЕРЕННО отделён от срока строкой ниже: принимающая
    // сторона аутентифицирована, и ей важно знать, что соискатель
    // передумал, — это не та же новость, что «время вышло».
    if (!share || share.consentSource !== CandidateConsentSource.CANDIDATE_SELF || !termIsCurrent(share)) throw new NotFoundException(TERM_OVER_MESSAGE);
    if (share.revokedAt) throw new ForbiddenException('Соискатель отозвал согласие — принять нельзя');
    if (share.acceptedAt) throw new BadRequestException('Эта ссылка уже была принята');
    const project = await assertInterviewPoolProjectAccess(this.prisma, userId, dto.projectId);
    if (!TEAM_MODES.has(project.mode)) throw new BadRequestException('Принять может проект агентства или работодателя');
    // Аудит заморозки 2026-09-03: проект-получатель приходит телом запроса,
    // поэтому ProjectFrozenGuard его не видит — принятие копии кандидата в
    // замороженный проект проходило мимо заморозки.
    await assertProjectNotFrozen(this.prisma, project.id);

    const payload = await this.buildPayload(share);
    const sourceProjectId = payload.sourceProjectId;
    // Сверка «половины операции» 2026-09-04: профиль, строка воронки и
    // отметка «ссылка использована» писались тремя отдельными вызовами.
    // Сбой между ними оставлял либо профиль вне воронки (получатель его
    // не видит, а согласие кандидата уже израсходовано), либо сожжённую
    // ссылку без профиля — «Эта ссылка уже была принята» при том, что не
    // принято ничего. Ссылка одноразовая и выдана самим человеком: сжечь
    // её впустую значит заставить его делиться своими данными заново, не
    // объяснив почему.
    const profile = await this.prisma.$transaction(async (tx) => {
      const created = await tx.candidateProfile.create({
        data: {
          ownerUserId: project.recruitingTeamId ? null : userId,
          recruitingTeamId: project.recruitingTeamId,
          displayName: payload.displayName,
          resumeText: payload.cvText,
          sharedFromProjectId: sourceProjectId,
          consentTextVersion: share.consentTextVersion,
        },
      });
      await tx.candidatePipelineStatus.create({ data: { projectId: project.id, candidateProfileId: created.id } });
      await tx.candidateShare.update({
        where: { id: share.id },
        data: { acceptedByUserId: userId, acceptedAt: new Date(), createdCandidateProfileId: created.id, acceptedIntoMode: project.mode },
      });
      return created;
    });
    // пункты соискателя — в INTERVIEW-лист получателя как «сказано кандидатом» (USER_STATED с цитатой)
    const status = await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId: project.id, candidateProfileId: profile.id } });
    if (status) {
      const sheet = await this.sheets.openForCandidate(userId, status.id, { silent: true });
      // Сверка «половины операции» 2026-09-04: пункты соискателя
      // переносятся целиком или не переносятся вовсе. Половина списка —
      // худший исход из трёх: получатель видит лист, который выглядит
      // полным, и обсуждает условия, часть которых человек отметил, а до
      // адресата они не доехали. Пустая сторона кандидата хотя бы видна
      // глазом. Отдельная транзакция, а не общая с профилем: лист
      // открывается чужим сервисом (`TermsSheetService` со своим
      // подключением), затянуть его в ту же транзакцию можно только
      // переделкой сигнатур — цена больше пользы, и разница между
      // «профиль без пунктов» и «пункты без профиля» здесь не в пользу
      // второго: профиль в воронке виден, а вот пункты без профиля
      // повисли бы ничьими.
      const orderStart = sheet.clauses.length;
      await this.prisma.$transaction(async (tx) => {
        let orderIndex = orderStart;
        for (const c of payload.clauses) {
          await tx.termsClause.create({
            data: {
              sheetId: sheet.id,
              side: 'CANDIDATE',
              kind: c.kind,
              text: c.text,
              category: c.category,
              isRequired: c.isRequired,
              orderIndex: orderIndex++,
              sourceEvidence: 'USER_STATED',
              sourceQuote: c.text.slice(0, 500),
              confirmedAt: new Date(),
            },
          });
        }
      });
    }
    await this.audit.record({ actorId: userId, action: 'candidate_self_share.accepted', resource: 'CandidateShare', resourceId: share.id, after: { profileId: profile.id, projectId: project.id } });
    return { profileId: profile.id, projectId: project.id, sharedFromProjectId: sourceProjectId };
  }

  /** Ровно то, что уходит: cvText + отмеченные пункты с текущими позициями соискателя. */
  private async buildPayload(share: { sourceCvVariantId: string | null; sourceSheetId: string | null; visibleClauseIds: string[]; sharedByUserId: string }) {
    const variant = share.sourceCvVariantId ? await this.prisma.cvVariant.findUnique({ where: { id: share.sourceCvVariantId } }) : null;
    const sheet = share.sourceSheetId ? await this.prisma.termsSheet.findUnique({ where: { id: share.sourceSheetId } }) : null;
    if (!variant || !sheet) throw new NotFoundException('Источник шеринга удалён');
    const all = await this.sheets.loadClauses(sheet.id);
    const clauses = all
      .filter((c) => share.visibleClauseIds.includes(c.id) && !c.rejectedAt)
      .map((c) => ({
        kind: c.kind,
        text: c.text,
        category: c.category,
        isRequired: c.isRequired,
        candidatePosition: c.current.CANDIDATE ? { coverage: c.current.CANDIDATE.coverage, stance: c.current.CANDIDATE.stance, quote: c.current.CANDIDATE.evidenceQuote } : null,
      }));
    const config = await this.prisma.jobSearchConfig.findUnique({ where: { projectId: sheet.projectId }, select: { desiredRole: true, cvDraft: true } });
    const headline = (config?.cvDraft as { headline?: string } | null)?.headline;
    return { displayName: headline || config?.desiredRole || 'Соискатель', cvText: variant.cvText, clauses, sourceProjectId: sheet.projectId, vacancyTitle: sheet.title };
  }
}
