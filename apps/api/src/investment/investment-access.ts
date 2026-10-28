// Пункт [investment] — командно-обізнана перевірка доступу до
// проекту: проект доступний, якщо userId є власником (ownerId) АБО
// членом InvestmentGroup цього проекту (§2.3/3.4/5.5 ТЗ — група
// координує спільну ціль, усі учасники повинні бачити той самий
// проект). АУДИТ ПЕРЕД РЕАЛІЗАЦІЄЮ: аналогічний хелпер для
// interview-pool (`assertInterviewPoolProjectAccess`) був пропущений
// у першому проході реалізації й доданий лише другим аудитом —
// цього разу спроєктовано одразу, той самий клас бага не повторюється
// втретє.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertInvestmentProjectAccess(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  // Пункт [the-domain-was-never-checked] 2026-10-27: режим проверяется
  // ДО членства — тот же порядок, что в `interview-pool-access.ts`,
  // где этот же дефект закрыли 2026-09-02, а сюда не перенесли —
  // хотя шапка этого файла говорит о том самом хелпере и о
  // том самом классе бага («той самий клас бага не повторюється
  // втрете»).
  //
  // ЧЕСТНО О СЕГОДНЯШНЕЙ ДОСТИЖИМОСТИ: член группы И БЕЗ этой
  // проверки не мог достать проект другого домена: `investmentGroupId`
  // в продукте записывается РОВНО В ОДНОМ МЕСТЕ и всегда вместе с
  // `mode: INVESTMENT`. То есть теам-ветка была безопасна не потому,
  // что здесь что-то проверялось, а потому что в другом файле одна
  // строка ставит два поля рядом. Инвариант, который нигде не
  // утверждён, инвариантом не является: «привязать существующий
  // проект к группе» — одна правка, после которой она стала бы
  // настоящим межпользовательским доступом к чужому домену.
  if (!project || project.mode !== ProjectMode.INVESTMENT) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  if (project.ownerId === userId) return project;
  if (project.investmentGroupId) {
    const membership = await prisma.investmentGroupMember.findUnique({
      where: { groupId_userId: { groupId: project.investmentGroupId, userId } },
    });
    if (membership) return project;
  }
  throw new NotFoundException(`Project ${projectId} not found`);
}
