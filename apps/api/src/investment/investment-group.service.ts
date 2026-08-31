// Пункт [investment] (devils-advocate-investment-tz.md §2.3/2.4/3.4/5.5):
// координація намірів групи, НЕ спільний рахунок і НЕ платіжна
// система. SEC "self-directed investment club" — учасники ДОСЛІДЖУЮТЬ
// разом, інвестують кожен окремо, гроші НІКОЛИ не проходять через
// продукт (§2.3 ТЗ).

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MoneyLike, sumMoney } from '../common/money';
import { InvestmentGroupRole } from '@prisma/client';

const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // той самий горизонт, що RecruitingTeamInvite

@Injectable()
export class InvestmentGroupService {
  constructor(private readonly prisma: PrismaService) {}

  /** Группы, в которых я состою, с моим взносом. */
  async listMyGroups(userId: string) {
    const rows = await this.prisma.investmentGroupMember.findMany({
      where: { userId },
      include: { group: { select: { id: true, name: true, createdAt: true, _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'desc' },
    });
    return rows.map((r: any) => ({ ...r.group, pledgedAmount: r.pledgedAmount, joinedAt: r.joinedAt }));
  }

  async createGroup(userId: string, name: string) {
    if (!name.trim()) {
      throw new BadRequestException('name не может быть пустым');
    }
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.investmentGroup.create({ data: { name: name.trim() } });
      await tx.investmentGroupMember.create({
        data: { groupId: group.id, userId, role: InvestmentGroupRole.OWNER },
      });
      return group;
    });
  }

  /** §2.4 ТЗ — той самий закритий deep-link механізм, що
   * RecruitingTeamInvite. Жодного публічного "списку відкритих груп". */
  async createInviteLink(userId: string, groupId: string) {
    await this.assertOwner(userId, groupId);
    const token = randomBytes(24).toString('base64url');
    await this.prisma.investmentGroupInvite.create({
      data: { groupId, token, expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) },
    });
    return { deepLink: `t.me/<bot>?start=investment_group_${token}`, token, expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) };
  }

  async joinGroup(userId: string, token: string) {
    const invite = await this.prisma.investmentGroupInvite.findUnique({ where: { token } });
    if (!invite || invite.expiresAt < new Date()) {
      throw new BadRequestException('Запрошення недійсне або прострочене');
    }
    const existing = await this.prisma.investmentGroupMember.findUnique({
      where: { groupId_userId: { groupId: invite.groupId, userId } },
    });
    if (existing) return existing;
    return this.prisma.investmentGroupMember.create({
      data: { groupId: invite.groupId, userId, role: InvestmentGroupRole.MEMBER },
    });
  }

  /** §3.4 ТЗ — ЗАЯВЛЕНИЙ намір, не проведена транзакція. Кожен
   * учасник встановлює лише СВІЙ власний pledgedAmount, не чужий —
   * той самий принцип, що явна згода в Пункті [interview-pool]
   * (не можна "погодити за когось"). */
  async setPledge(userId: string, groupId: string, pledgedAmount: number) {
    const membership = await this.assertMember(userId, groupId);
    if (pledgedAmount < 0) {
      throw new BadRequestException('pledgedAmount не может быть отрицательным');
    }
    return this.prisma.investmentGroupMember.update({
      where: { id: membership.id },
      data: { pledgedAmount },
    });
  }

  /** §5.5 ТЗ — тільки читання/відображення прогресу, жодного
   * ендпоінта "перевести кошти"/"підтвердити отримання" в продукті
   * взагалі (немає платіжної інфраструктури).
   *
   * АУДИТ: прогрес прив'язаний до КОНКРЕТНОГО проєкту, не до групи
   * самої по собі — `InvestmentGroup.projects` це one-to-many (одна
   * група може стояти за кількома різними інвестиційними цілями
   * одночасно), тому "єдиного targetBudget групи" не існує
   * структурно; targetBudget читається з InvestmentConfig того
   * проєкту, для якого запитується прогрес, не передається ззовні. */
  async getProjectProgress(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || !project.investmentGroupId) {
      throw new NotFoundException(`Project ${projectId} not found or has no investment group`);
    }
    await this.assertMember(userId, project.investmentGroupId);

    const [config, members] = await Promise.all([
      this.prisma.investmentConfig.findUnique({ where: { projectId }, select: { targetBudget: true, currency: true } }),
      this.prisma.investmentGroupMember.findMany({
        where: { groupId: project.investmentGroupId },
        select: { userId: true, pledgedAmount: true },
        orderBy: { joinedAt: 'asc' },
      }),
    ]);
    const totalPledged = sumMoney(members.map((m: { pledgedAmount: MoneyLike }) => m.pledgedAmount));
    return { targetBudget: config?.targetBudget ?? null, currency: config?.currency ?? null, totalPledged, members };
  }

  private async assertMember(userId: string, groupId: string) {
    const membership = await this.prisma.investmentGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership) {
      throw new NotFoundException(`InvestmentGroup ${groupId} not found`);
    }
    return membership;
  }

  private async assertOwner(userId: string, groupId: string) {
    const membership = await this.assertMember(userId, groupId);
    if (membership.role !== InvestmentGroupRole.OWNER) {
      throw new ForbiddenException('Тільки власник групи може запрошувати нових учасників');
    }
    return membership;
  }
}
