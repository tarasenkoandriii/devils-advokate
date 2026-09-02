// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.6/§4.4):
// кандидати + обмін через Telegram.
//
// АУДИТ ПЕРЕД РЕАЛІЗАЦІЄЮ (див. коментар над CandidateShare у schema.prisma):
// перша версія ТЗ описувала пакетний шеринг як "масив sourceCandidateId
// замість одного" — математично неможливо в самій же схемі документа
// (sourceCandidateId скалярне, shareToken @unique). Виправлено:
// shareToken (одиночний) і batchToken (пакетний, НЕ unique — кілька
// рядків з однаковим значенням і є сам механізм пакета) — окремі поля.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';

const SHARE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // §4.6 ТЗ: "за замовчуванням 72 години"

@Injectable()
export class InterviewPoolCandidateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Мои профили кандидатов: созданные мной + расшаренные в команды, где я
   * состою. До этого TMA просил ввести ID профиля руками (create-only API). */
  async listMyCandidates(userId: string) {
    const memberships = await this.prisma.recruitingTeamMember.findMany({ where: { userId }, select: { teamId: true } });
    const teamIds = memberships.map((m: { teamId: string }) => m.teamId);
    return this.prisma.candidateProfile.findMany({
      where: { OR: [{ ownerUserId: userId }, ...(teamIds.length ? [{ recruitingTeamId: { in: teamIds } }] : [])] },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, displayName: true, contactInfo: true, recruitingTeamId: true, ownerUserId: true, updatedAt: true },
    });
  }

  async createCandidate(userId: string, displayName: string, contactInfo?: string, resumeText?: string, recruitingTeamId?: string) {
    if (!displayName.trim()) {
      throw new BadRequestException('displayName не может быть пустым');
    }
    if (recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: recruitingTeamId, userId } },
      });
      if (!membership) {
        throw new NotFoundException(`RecruitingTeam ${recruitingTeamId} not found`);
      }
    }
    return this.prisma.candidateProfile.create({
      data: {
        displayName: displayName.trim(),
        contactInfo,
        resumeText,
        // Належить команді АБО одноосібному власнику, не обидвом
        // одразу (§3.0 ТЗ, коментар у схемі).
        ownerUserId: recruitingTeamId ? undefined : userId,
        recruitingTeamId: recruitingTeamId ?? undefined,
      },
    });
  }

  // ── Домашнє завдання (§4.4 ТЗ) ──

  async listFollowUpRequests(userId: string, statusId: string) {
    await this.assertOwnedStatus(userId, statusId);
    return this.prisma.candidateFollowUpRequest.findMany({ where: { statusId }, orderBy: { createdAt: 'desc' } });
  }

  async markFollowUpFulfilled(userId: string, requestId: string, fulfilled: boolean) {
    const request = await this.prisma.candidateFollowUpRequest.findUnique({
      where: { id: requestId },
      include: { status: true },
    });
    if (!request) {
      throw new NotFoundException(`CandidateFollowUpRequest ${requestId} not found`);
    }
    await this.assertOwnedStatus(userId, request.statusId);
    return this.prisma.candidateFollowUpRequest.update({ where: { id: requestId }, data: { fulfilled } });
  }

  // ── Обмін через Telegram (§4.6 ТЗ) ──

  /** Поштучний шеринг. §2.5 ТЗ, п.1 — без candidateConsentConfirmed=true
   * кнопка технічно недоступна, не тільки етично не рекомендована. */
  async shareCandidate(userId: string, candidateProfileId: string, candidateConsentConfirmed: boolean) {
    await this.assertOwnedOrTeamCandidate(userId, candidateProfileId);
    if (!candidateConsentConfirmed) {
      throw new BadRequestException('Без підтвердженої згоди кандидата на передачу — поділитись неможливо');
    }
    const shareToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_MS);
    await this.prisma.candidateShare.create({
      data: {
        sourceCandidateId: candidateProfileId,
        sharedByUserId: userId,
        shareToken,
        expiresAt,
        candidateConsentConfirmed: true,
      },
    });
    return { deepLink: `t.me/<bot>?start=share_${shareToken}`, expiresAt };
  }

  /** Пакетний шеринг усього пулу. §2.5 ТЗ: "не можна погодити всіх
   * одним чекбоксом" — candidateConsentConfirmed передається як
   * МАСИВ id, для яких згода підтверджена; решта пулу мовчки НЕ
   * потрапляє в пакет (не помилка на весь запит).
   *
   * АУДИТ ЗНАЙШОВ КРИТИЧНУ ДІРУ: цей метод раніше НЕ перевіряв
   * доступ userId до projectId взагалі — будь-який автентифікований
   * користувач міг поділитись усіма кандидатами ЧУЖОГО пулу, знаючи
   * лише projectId. Усі інші методи цього сервісу мають перевірку
   * власності/команди, цей — пропустили. Виправлено. */
  async shareAllInPool(userId: string, projectId: string, consentedCandidateIds: string[]) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    const allInPool = await this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      select: { candidateProfileId: true },
    });
    const consentedSet = new Set(consentedCandidateIds);
    const included = allInPool.filter((s: { candidateProfileId: string }) => consentedSet.has(s.candidateProfileId));
    const excludedCount = allInPool.length - included.length;

    if (included.length === 0) {
      throw new BadRequestException('Жоден кандидат пулу не має підтвердженої згоди на шеринг — пакет не може бути порожнім');
    }

    const batchToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_MS);
    await this.prisma.candidateShare.createMany({
      data: included.map((s: { candidateProfileId: string }) => ({
        sourceCandidateId: s.candidateProfileId,
        sharedByUserId: userId,
        batchToken,
        expiresAt,
        candidateConsentConfirmed: true,
      })),
    });

    return { deepLink: `t.me/<bot>?start=team_share_${batchToken}`, expiresAt, includedCount: included.length, excludedCount };
  }

  /** §4.6 ТЗ — попередній перегляд БЕЗ pipelineStatuses/relevanceEntries,
   * тільки displayName/resumeText. Приймає і shareToken (одиночний), і
   * batchToken (пакетний) — повертає масив з одним чи кількома
   * кандидатами відповідно. */
  async previewShare(token: string) {
    const shares = await this.prisma.candidateShare.findMany({
      where: { OR: [{ shareToken: token }, { batchToken: token }] },
      include: { sourceCandidate: { select: { displayName: true, resumeText: true } } },
    });
    if (shares.length === 0) {
      throw new NotFoundException('Посилання недійсне');
    }
    if (shares[0].expiresAt < new Date()) {
      throw new BadRequestException('Посилання прострочене');
    }
    return shares.map((s: any) => ({ shareId: s.id, displayName: s.sourceCandidate.displayName, resumeText: s.sourceCandidate.resumeText }));
  }

  /** §4.6 ТЗ — "явна дія отримувача, не автоматичний імпорт". Приймає
   * ОДИН конкретний shareId з preview (не весь пакет одразу) — новий
   * CandidateProfile, копія на момент прийняття, НЕ live-посилання на
   * оригінал. */
  async acceptShare(userId: string, shareId: string, token: string) {
    const share = await this.prisma.candidateShare.findUnique({
      where: { id: shareId },
      include: { sourceCandidate: true },
    });
    // Пункт [project-audit] 2026-09-01 (IDOR из отчёта аудита): раньше
    // хватало одного shareId — внутреннего cuid, который не является
    // секретом (мелькает в ответах API и логах). Теперь принятие
    // требует ещё и токен ссылки — то, что получатель реально получил
    // в deep-link'е. Несовпадение неотличимо от несуществующей ссылки
    // (не раскрываем, что shareId существует).
    if (!share || !token?.trim() || (share.shareToken !== token && share.batchToken !== token)) {
      throw new NotFoundException('Посилання недійсне або прострочене');
    }
    if (share.expiresAt < new Date()) {
      throw new NotFoundException('Посилання недійсне або прострочене');
    }
    if (share.acceptedAt) {
      throw new BadRequestException('Це посилання вже було прийнято раніше');
    }

    const newProfile = await this.prisma.candidateProfile.create({
      data: {
        ownerUserId: userId,
        displayName: share.sourceCandidate.displayName,
        contactInfo: share.sourceCandidate.contactInfo,
        resumeText: share.sourceCandidate.resumeText,
      },
    });

    await this.prisma.candidateShare.update({
      where: { id: shareId },
      data: { acceptedByUserId: userId, acceptedAt: new Date(), createdCandidateProfileId: newProfile.id },
    });

    return newProfile;
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedOrTeamCandidate(userId: string, candidateProfileId: string) {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: candidateProfileId } });
    if (!candidate) {
      throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
    }
    if (candidate.ownerUserId === userId) return candidate;
    if (candidate.recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: candidate.recruitingTeamId, userId } },
      });
      if (membership) return candidate;
    }
    throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
  }

  private async assertOwnedStatus(userId: string, statusId: string) {
    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { id: statusId },
      include: { project: true },
    });
    if (!status) {
      throw new NotFoundException(`CandidatePipelineStatus ${statusId} not found`);
    }
    await assertInterviewPoolProjectAccess(this.prisma, userId, status.projectId);
    return status;
  }
}
