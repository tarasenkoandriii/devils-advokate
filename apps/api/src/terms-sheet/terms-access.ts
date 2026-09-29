// Пункт [job-domain-v2] §6.1 — доступ к проекту любой из трёх ролей найма
// выбирается ПО РЕЖИМУ ПРОЕКТА, а не по виду листа: JOB_SEARCH — только
// владелец (CV — личные данные, командного доступа нет по построению);
// INTERVIEW_POOL и EMPLOYER_HIRING — команда (RecruitingTeam, одна
// таблица на агентство и работодателя). Один хелпер, чтобы правило не
// расползлось по восьми сервисам связок.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertOwnedJobSearchProject } from '../job-search/job-search-access';
import { assertInterviewPoolProjectAccess, TEAM_MODES } from '../interview-pool/interview-pool-access';

export const HIRING_MODES: ReadonlySet<ProjectMode> = new Set([ProjectMode.JOB_SEARCH, ...TEAM_MODES]);

export async function assertHiringProjectAccess(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, mode: true } });
  if (!project || !HIRING_MODES.has(project.mode)) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  if (project.mode === ProjectMode.JOB_SEARCH) {
    return assertOwnedJobSearchProject(prisma, userId, projectId);
  }
  return assertInterviewPoolProjectAccess(prisma, userId, projectId);
}

/** Функции, помеченные в реестре §12 «только INTERVIEW_POOL» (А-25, А-27,
 * А-29, А-30), в проекте работодателя отвечают 404 «не применимо к роли»
 * (приёмка 44) — не 403: маршрут для этой роли не существует. */
export function assertRoleApplicable(mode: ProjectMode, allowed: ReadonlySet<ProjectMode>, featureId: string) {
  if (!allowed.has(mode)) {
    throw new NotFoundException(`${featureId}: не применимо к роли этого проекта`);
  }
}

export const AGENCY_ONLY: ReadonlySet<ProjectMode> = new Set([ProjectMode.INTERVIEW_POOL]);
