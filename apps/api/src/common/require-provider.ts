import { ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Повторный аудит 2026-09-01. Семь мест в коде читали строку провайдера
 * через `findUniqueOrThrow({ where: { name: 'assemblyai' } })`. Если её
 * в БД нет (сид не прогнан на этой базе), Prisma бросает P2025, а
 * ApiExceptionFilter распознаёт только P2021/P2022/Initialization — то
 * есть пользователь получал голое «500 Internal server error» на
 * загрузке записи, а причина («выполните сид») не называлась нигде.
 *
 * Это тот же класс, что найденный в этот же день разрыв «код ↔ строки
 * конфигурации в БД»: отсутствие строки-настройки не должно выглядеть
 * как поломка сервера.
 */
export async function requireAIProvider(prisma: PrismaService, name: string) {
  const provider = await prisma.aIProvider.findUnique({ where: { name } });
  if (!provider) {
    throw new ServiceUnavailableException(
      `Провайдер «${name}» не настроен в базе: строки AIProvider нет. ` +
        'Это конфигурация, а не сбой внешнего сервиса — выполните `npm run prisma:seed` против этой базы ' +
        '(см. VERCEL.md, раздел «Первый деплой базы данных»).',
    );
  }
  return provider;
}
