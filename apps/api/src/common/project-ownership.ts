// Общая проверка владения проектом (ownerId === userId).
//
// Раньше этот код был скопирован в ProjectsService и отдельно, но с
// ошибкой — забыт, в ArgumentGenerationService (реальная авторизационная
// дыра, найденная и закрытая при реализации фичи 2, см. Prisma README).
// Третий раз копипастить его же в PersonsService — гарантированный
// способ повторить тот же класс бага снова. Вынесено сюда один раз.
//
// NotFoundException, не ForbiddenException — единообразно и для
// "не существует", и для "существует, но не ваш", чтобы снаружи нельзя
// было отличить эти два случая (см. ProjectsService, тот же принцип).

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export async function assertProjectOwnership(
  prisma: PrismaService,
  userId: string,
  projectId: string,
): Promise<{ id: string; question: string; goal: string | null }> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
  });
  if (!project) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
