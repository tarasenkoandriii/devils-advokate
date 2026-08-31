// ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md, §1.1–1.2 (фаза A).
// Шесть доменных конвейеров (dtp / family-law / health / interview-pool /
// investment / major-purchase) имели только POST projects и POST answers —
// ни списка проектов домена, ни чтения уже данных ответов онбординга
// (bug class «create-only API missing read endpoint»). Два read-helper'а,
// общие для всех шести — домен различается только ProjectMode.
import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const DOMAIN_PROJECTS_MAX_TAKE = 100;

export interface ListDomainProjectsOptions { take?: number; skip?: number }

export async function listDomainProjects(
  prisma: PrismaService,
  userId: string,
  mode: ProjectMode,
  options: ListDomainProjectsOptions = {},
) {
  const take = Math.min(Math.max(options.take ?? 20, 1), DOMAIN_PROJECTS_MAX_TAKE);
  const skip = Math.max(options.skip ?? 0, 0);
  const where = { ownerId: userId, mode };
  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
      select: { id: true, question: true, mode: true, createdAt: true, updatedAt: true },
    }),
    prisma.project.count({ where }),
  ]);
  return { items, total, take, skip };
}

/** Ответы онбординг-разговора в исходном порядке — то, что appendAnswer()
 * писал как TranscriptSegment. Нужно для возобновления онбординга после
 * перезапуска Mini App и для показа истории после replay из intake-квиза. */
export async function getOnboardingAnswers(prisma: PrismaService, userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, project: { ownerId: userId } },
    select: { id: true, projectId: true, status: true, createdAt: true },
  });
  if (!conversation) {
    throw new NotFoundException(`Onboarding conversation ${conversationId} not found`);
  }
  const transcript = await prisma.transcript.findUnique({
    where: { conversationId },
    include: { segments: { orderBy: { startMs: 'asc' }, select: { id: true, text: true, startMs: true } } },
  });
  return {
    ...conversation,
    answers: (transcript?.segments ?? []).map((s) => ({ id: s.id, text: s.text, orderMs: s.startMs })),
  };
}
