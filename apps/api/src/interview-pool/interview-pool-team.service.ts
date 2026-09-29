// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.5):
// командна співпраця — агенція/колаб на конкретний проект. Той самий
// принцип generation токена, що вже застосований у PublicDiscussionService.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RecruitingTeamRole, RecruitingTeamType } from '@prisma/client';
import { buildStartDeepLink } from '../common/telegram-deep-link';

const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72 години, той самий горизонт, що share-токени §4.6 ТЗ

@Injectable()
export class InterviewPoolTeamService {
  constructor(private readonly prisma: PrismaService) {}

  /** Команды, в которых я состою, с ролью. */
  async listMyTeams(userId: string) {
    const rows = await this.prisma.recruitingTeamMember.findMany({
      where: { userId },
      include: { team: { select: { id: true, name: true, teamType: true, createdAt: true, _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'desc' },
    });
    return rows.map((r: any) => ({ ...r.team, role: r.role, joinedAt: r.joinedAt }));
  }

  /** [job-domain-v2] §7.1: teamType — AGENCY (по умолчанию) или EMPLOYER
   * (команда компании: HR, нанимающий менеджер, интервьюеры). */
  async createTeam(userId: string, name: string, teamType: RecruitingTeamType = RecruitingTeamType.AGENCY) {
    if (!name.trim()) {
      throw new BadRequestException('name не может быть пустым');
    }
    return this.prisma.$transaction(async (tx) => {
      const team = await tx.recruitingTeam.create({ data: { name: name.trim(), teamType } });
      await tx.recruitingTeamMember.create({
        data: { teamId: team.id, userId, role: RecruitingTeamRole.OWNER },
      });
      return team;
    });
  }

  /** Той самий принцип, що PublicDiscussionService.enableSharing() —
   * непередбачуваний токен, URL-safe. Зберігається транзитно в
   * RecruitingTeamInvite (окрема легка модель, не поле на самій
   * команді — команда може мати кілька активних запрошень одночасно,
   * кожне з власним expiresAt). */
  async createInviteLink(userId: string, teamId: string) {
    await this.assertOwner(userId, teamId);
    const token = randomBytes(24).toString('base64url');
    await this.prisma.recruitingTeamInvite.create({
      data: { teamId, token, expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) },
    });
    return { deepLink: buildStartDeepLink(`team_${token}`), token, expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) };
  }

  /** Сверка вебхуков и токенов 2026-09-04: список активных приглашений.
   * Отозвать можно только то, что видно, — раньше владелец не мог даже
   * узнать, сколько ссылок в его команду сейчас живо. */
  async listInvites(userId: string, teamId: string) {
    await this.assertOwner(userId, teamId);
    return this.prisma.recruitingTeamInvite.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
    });
  }

  /** Отзыв приглашения. Уже вошедших он не выкидывает — это отдельное
   * действие («убрать участника»), и смешивать их значило бы обещать
   * человеку то, чего кнопка не делает. */
  async revokeInvite(userId: string, teamId: string, inviteId: string) {
    await this.assertOwner(userId, teamId);
    const invite = await this.prisma.recruitingTeamInvite.findFirst({ where: { id: inviteId, teamId } });
    if (!invite) throw new BadRequestException('Приглашение не найдено в этой команде');
    return this.prisma.recruitingTeamInvite.update({
      where: { id: invite.id },
      data: { revokedAt: invite.revokedAt ?? new Date() },
      select: { id: true, revokedAt: true },
    });
  }

  async joinTeam(userId: string, token: string) {
    const invite = await this.prisma.recruitingTeamInvite.findUnique({ where: { token } });
    if (!invite || invite.expiresAt < new Date() || invite.revokedAt) {
      // Отозванное и просроченное — одна формулировка намеренно: тот, у
      // кого ссылка, не должен по тексту отказа понимать, отозвали её
      // конкретно или срок вышел у всех.
      throw new BadRequestException('Приглашение недействительно или просрочено');
    }
    // Пункт [check-then-create] 2026-09-04: было «прочитать, есть ли
    // членство, и создать, если нет». Замысел здесь именно
    // идемпотентный — уже состоящий в команде просто получает своё
    // членство обратно, — но реализация оставляла окно: два перехода по
    // ссылке подряд проходили проверку оба, и второй падал с P2002 на
    // уникальном (teamId, userId). Человек видел ошибку там, где по
    // замыслу должно быть «вы уже в команде».
    //
    // `upsert` выражает тот же замысел без окна: `update: {}` означает
    // «ничего не менять, если уже есть» — роль вступившего раньше не
    // переписывается повторным переходом по ссылке.
    return this.prisma.recruitingTeamMember.upsert({
      where: { teamId_userId: { teamId: invite.teamId, userId } },
      update: {},
      create: { teamId: invite.teamId, userId, role: RecruitingTeamRole.MEMBER },
    });
  }

  /** §4.5 ТЗ — "повний спільний доступ до бази команди, не
   * по-проектна ізоляція", свідомий вибір цього проходу. */
  async listCandidates(userId: string, teamId: string) {
    await this.assertMember(userId, teamId);
    return this.prisma.candidateProfile.findMany({ where: { recruitingTeamId: teamId }, orderBy: { createdAt: 'desc' } });
  }

  private async assertMember(userId: string, teamId: string) {
    const membership = await this.prisma.recruitingTeamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!membership) {
      throw new NotFoundException(`RecruitingTeam ${teamId} not found`);
    }
    return membership;
  }

  private async assertOwner(userId: string, teamId: string) {
    const membership = await this.assertMember(userId, teamId);
    if (membership.role !== RecruitingTeamRole.OWNER) {
      throw new ForbiddenException('Только владелец команды может приглашать новых участников');
    }
    return membership;
  }
}
