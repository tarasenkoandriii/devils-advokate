// Пункт [dtp] — просте власницьке ownership, той самий принцип, що
// health-access.ts/family-law-access.ts.

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedDtpProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  if (!project) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
