// Пункт [health] — просте власницьке ownership, без команди/групи
// (§3.4 ТЗ: групового виміру навмисно немає, не запитано в
// прямому запиті документа). Простіше за
// assertInvestmentProjectAccess/assertInterviewPoolProjectAccess —
// не додаю команд-обізнаність "про запас", там, де вона не потрібна.

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedHealthProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  if (!project) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
