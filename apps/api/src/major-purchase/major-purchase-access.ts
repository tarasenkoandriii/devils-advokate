// Пункт [the-domain-was-never-checked] 2026-10-27 — ворота домена
// крупной покупки.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, КАК У ОСТАЛЬНЫХ ДОМЕНОВ. Эта проверка жила
// ДВУМЯ приватными копиями — в `major-purchase.service.ts` и в
// `major-purchase-onboarding.service.ts`, слово в слово. Копия — это не
// «немного дублирования»: ровно так расходятся правила, и весь список
// находок этого проекта состоит из «правило было, просто не везде».
// У шести других доменов ворота живут отдельным файлом; здесь теперь
// тоже.
//
// РЕЖИМ ПРОЕКТА ПРОВЕРЯЕТСЯ. Прежние копии проверяли только владение, а
// метод назывался `assertOwnedMajorPurchaseProject` — то есть называл
// домен и не спрашивал о нём. Разбор вреда и измерение — в шапке
// `src/__tests__/audit-2026-10-27-the-domain-was-never-checked.spec.ts`.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export async function assertOwnedMajorPurchaseProject(prisma: PrismaService, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  // Отказ один и тот же на все три причины (нет проекта, чужой проект,
  // другой сценарий) — та же форма, что у `job-search-access.ts`:
  // существование чужого проекта наружу не подтверждается.
  if (!project || project.mode !== ProjectMode.MAJOR_PURCHASE) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return project;
}
