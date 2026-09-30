// Пункт [the-meter-was-on-one-door] 2026-09-30 — потолок поминутной
// оплаты стоял на одной двери из трёх.
//
// НАЙДЕНО. `TRANSCRIPTIONS_PER_USER_PER_DAY` и
// `TRANSCRIPTION_MINUTES_PER_USER_PER_DAY` проверялись в ЕДИНСТВЕННОМ
// месте — `ConversationsService.assertUnderDailyTranscriptionLimit`. Ещё
// две точки отправляют задачи ТЕМ ЖЕ поминутно тарифицируемым
// провайдерам (AssemblyAI / Soniox) и потолка не звали вовсе:
//
//   sparring.service.ts       → submitVoiceReply → stt.submitWebhookJob
//   material-chat.service.ts  → submitVoiceReply → stt.submitWebhookJob
//
// Единственным ограничением там был `MAX_MESSAGES_PER_SESSION = 40` на
// сессию, а потолка на СОЗДАНИЕ сессий нет: сорок реплик → новая сессия
// → ещё сорок, сколько угодно раз. Платит владелец ключа, по минутам.
//
// Комментарий реестра расходов говорил «до этого пункта потолка не было
// вовсе» — и это было верно ровно про разговоры. Ровно тот класс,
// который проект уже называл девять раз: «правило было, просто не
// везде».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ТРЕТЬЯ КОПИЯ. Три копии одной проверки
// разъедутся так же, как разъехались проверки согласий (та же причина
// названа в `common/timing-safe-equal.ts`). Здесь ОДНО место, и оба
// шага — и проверка потолка, и запись расхода — идут вместе: запись без
// проверки бесполезна, проверка без записи не считает.
//
// ПОРЯДОК НАМЕРЕННЫЙ: отметка расхода пишется ДО платного вызова.
// Неудачная попытка тоже засчитывается — провайдер мог быть уже задет,
// а недосчитать здесь дороже, чем пересчитать. То же правило, что в
// `youtube-search.service.ts`.
//
// ЧЕГО ЭТО НЕ ДЕЛАЕТ, и это надо сказать прямо. Длительность кладём
// такой, какой её назвал клиент (у голосовой реплики её нет вовсе —
// `null`), поэтому потолок по минутам голосовые реплики НЕ ограничивает:
// их держит потолок по числу расшифровок. Считать по длительности,
// которую вернул провайдер, было бы честнее — продукт её не хранит, и
// заводить ради счётчика колонку с ручной миграцией здесь не стали.

import { HttpException, HttpStatus } from '@nestjs/common';
import { spendLimit } from '../common/spend-limits';
import type { PrismaService } from '../prisma/prisma.service';

/** Действие в журнале, по которому считается суточный расход. Имя одно
 * на все три двери — иначе потолок считал бы только свою. */
export const TRANSCRIPTION_USAGE_ACTION = 'transcription.requested';

export async function assertUnderDailyTranscriptionLimit(prisma: PrismaService, userId: string): Promise<void> {
  const countLimit = spendLimit('TRANSCRIPTIONS_PER_USER_PER_DAY');
  const minutesLimit = spendLimit('TRANSCRIPTION_MINUTES_PER_USER_PER_DAY');
  if (countLimit === 0 && minutesLimit === 0) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.auditLogEntry.findMany({
    where: { actorId: userId, action: TRANSCRIPTION_USAGE_ACTION, createdAt: { gte: since } },
    select: { after: true },
  });

  if (countLimit > 0 && recent.length >= countLimit) {
    // 429, как у остальных потолков: предел временный, не правовой.
    throw new HttpException(
      `Достигнут суточный лимит расшифровок (${countLimit}/сутки). Попробуйте позже.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  if (minutesLimit > 0) {
    const seconds = recent.reduce((sum: number, e: { after: unknown }) => {
      const value = (e.after as { durationSeconds?: number | null } | null)?.durationSeconds;
      return sum + (typeof value === 'number' && value > 0 ? value : 0);
    }, 0);
    if (seconds >= minutesLimit * 60) {
      throw new HttpException(
        `Достигнут суточный лимит расшифровки по длительности (${minutesLimit} мин/сутки). Попробуйте позже.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** Отметка расхода. Содержимого записи в журнале нет — только её
 * длина, и то со слов клиента. */
export async function recordTranscriptionSpend(
  prisma: PrismaService,
  userId: string,
  resource: string,
  resourceId: string,
  durationSeconds: number | null,
): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      actorId: userId,
      action: TRANSCRIPTION_USAGE_ACTION,
      resource,
      resourceId,
      after: { durationSeconds },
    },
  });
}
