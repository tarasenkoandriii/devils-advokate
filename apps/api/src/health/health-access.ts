// Пункт [health] — просте власницьке ownership, без команди/групи
// (§3.4 ТЗ: групового виміру навмисно немає, не запитано в
// прямому запиті документа). Простіше за
// assertInvestmentProjectAccess/assertInterviewPoolProjectAccess —
// не додаю команд-обізнаність "про запас", там, де вона не потрібна.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedHealthProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  // Пункт [the-domain-was-never-checked] 2026-10-27: режим проекта
  // проверяется здесь, а не только владение. Урок был записан в
  // `interview-pool-access.ts` 2026-09-02 со всем вредом дословно
  // («сущности создавались на проекте, которого нет в списке домена:
  // данные есть, из интерфейса недостижимы») — и применён только
  // там и в job-search. Замер и разбор — в шапке сверки
  // `src/__tests__/audit-2026-10-27-the-domain-was-never-checked.spec.ts`.
  if (!project || project.mode !== ProjectMode.HEALTH) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
