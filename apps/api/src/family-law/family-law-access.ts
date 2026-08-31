// Пункт [family-law] — просте власницьке ownership, без групи
// (§3.4 ТЗ: спільного проєкту для обох сторін подружжя не існує
// структурно, той самий принцип, що health-access.ts).

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedFamilyLawProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  if (!project) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
