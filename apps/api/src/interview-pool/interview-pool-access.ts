// Пункт [interview-pool] — командно-обізнана перевірка доступу до
// проекту: проект доступний, якщо userId є власником (ownerId) АБО
// членом RecruitingTeam цього проекту (§4.5 ТЗ: "будь-який
// RecruitingTeamMember бачить усі Project(и) команди"). Винесено в
// спільний хелпер одразу, не продубльовано по сервісах — той самий
// клас бага, що вже колись знаходився й закривався для звичайного
// assertProjectOwnership() (Prisma README, "Пункт 2").

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertInterviewPoolProjectAccess(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  // АУДИТ 2026-09-02: режим проекта не проверялся (в job-search такая
  // проверка есть). Владелец мог вызвать весь interview-pool API на
  // своём проекте ЛЮБОГО домена — не IDOR (проект свой), но сущности
  // пула создавались на проекте, которого нет в списке домена: данные
  // есть, из интерфейса недостижимы. Плюс расширялась поверхность для
  // члена команды: доступ давался по recruitingTeamId без учёта режима.
  if (!project || project.mode !== ProjectMode.INTERVIEW_POOL) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  if (project.ownerId === userId) return project;
  if (project.recruitingTeamId) {
    const membership = await prisma.recruitingTeamMember.findUnique({
      where: { teamId_userId: { teamId: project.recruitingTeamId, userId } },
    });
    if (membership) return project;
  }
  throw new NotFoundException(`Project ${projectId} not found`);
}
