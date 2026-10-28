// Пункт [dtp] — просте власницьке ownership, той самий принцип, що
// health-access.ts/family-law-access.ts.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedDtpProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  // Пункт [the-domain-was-never-checked] 2026-10-27: режим проекта
  // проверяется здесь, а не только владение. Урок был записан в
  // `interview-pool-access.ts` 2026-09-02 со всем вредом дословно
  // («сущности создавались на проекте, которого нет в списке домена:
  // данные есть, из интерфейса недостижимы») — и применён только
  // там и в job-search. Замер и разбор — в шапке сверки
  // `src/__tests__/audit-2026-10-27-the-domain-was-never-checked.spec.ts`.
  if (!project || project.mode !== ProjectMode.DTP) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
