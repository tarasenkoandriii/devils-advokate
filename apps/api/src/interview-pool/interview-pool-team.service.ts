// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.5):
// командна співпраця — агенція/колаб на конкретний проект. Той самий
// принцип generation токена, що вже застосований у PublicDiscussionService.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RecruitingTeamRole } from '@prisma/client';

const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72 години, той самий горизонт, що share-токени §4.6 ТЗ

@Injectable()
export class InterviewPoolTeamService {
  constructor(private readonly prisma: PrismaService) {}

  /** Команды, в которых я состою, с ролью. */
  async listMyTeams(userId: string) {
    const rows = await this.prisma.recruitingTeamMember.findMany({
      where: { userId },
      include: { team: { select: { id: true, name: true, createdAt: true, _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'desc' },
    });
    return rows.map((r: any) => ({ ...r.team, role: r.role, joinedAt: r.joinedAt }));
  }

  async createTeam(userId: string, name: string) {
    if (!name.trim()) {
      throw new BadRequestException('name не может быть пустым');
    }
    return this.prisma.$transaction(async (tx) => {
      const team = await tx.recruitingTeam.create({ data: { name: name.trim() } });
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
    return { deepLink: `t.me/<bot>?start=team_${token}`, token, expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) };
  }

  async joinTeam(userId: string, token: string) {
    const invite = await this.prisma.recruitingTeamInvite.findUnique({ where: { token } });
    if (!invite || invite.expiresAt < new Date()) {
      throw new BadRequestException('Запрошення недійсне або прострочене');
    }
    const existing = await this.prisma.recruitingTeamMember.findUnique({
      where: { teamId_userId: { teamId: invite.teamId, userId } },
    });
    if (existing) return existing;
    return this.prisma.recruitingTeamMember.create({
      data: { teamId: invite.teamId, userId, role: RecruitingTeamRole.MEMBER },
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
      throw new ForbiddenException('Тільки власник команди може запрошувати нових членів');
    }
    return membership;
  }
}
