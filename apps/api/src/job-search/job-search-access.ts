// Пункт [job-search] 2026-09-01 — проверка доступа к проекту домена.
// Групповой механики у поиска работы нет (CV — личные данные, никакого
// «командного» доступа по построению), поэтому только владелец — тот
// же простой контур, что у health.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedJobSearchProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.ownerId !== userId || project.mode !== ProjectMode.JOB_SEARCH) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
