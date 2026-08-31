// Пункт [investment] — командно-обізнана перевірка доступу до
// проекту: проект доступний, якщо userId є власником (ownerId) АБО
// членом InvestmentGroup цього проекту (§2.3/3.4/5.5 ТЗ — група
// координує спільну ціль, усі учасники повинні бачити той самий
// проект). АУДИТ ПЕРЕД РЕАЛІЗАЦІЄЮ: аналогічний хелпер для
// interview-pool (`assertInterviewPoolProjectAccess`) був пропущений
// у першому проході реалізації й доданий лише другим аудитом —
// цього разу спроєктовано одразу, той самий клас бага не повторюється
// втретє.

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertInvestmentProjectAccess(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  if (project.ownerId === userId) return project;
  if (project.investmentGroupId) {
    const membership = await prisma.investmentGroupMember.findUnique({
      where: { groupId_userId: { groupId: project.investmentGroupId, userId } },
    });
    if (membership) return project;
  }
  throw new NotFoundException(`Project ${projectId} not found`);
}
