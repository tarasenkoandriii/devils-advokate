// Пункт 50: SchedulerService (§3.20 ТЗ) — планировщик разговоров и
// push-напоминания (пункт 30 v3-роадмапа). По прямому запросу, после
// пересмотра более раннего вывода "инфраструктуры push нет вообще"
// (см. диалог перед этим пунктом) — вывод оказался верным для Vercel
// Cron конкретно (Hobby-тариф ограничен раз в сутки, бесполезно для
// напоминания "за час до"), но не для pg_cron+pg_net через Supabase —
// установившегося у пользователя паттерна в других проектах, здесь
// ранее не настроенного.
//
// АРХИТЕКТУРА ДИСПЕТЧЕРИЗАЦИИ: pg_cron (внутри Supabase Postgres)
// планируется на частый интервал (например, каждую минуту) и через
// pg_net делает HTTP-запрос на dispatchDueReminders() ЭТОГО сервиса
// (см. scheduler.controller.ts) — не отправляет Telegram-сообщения
// напрямую из SQL. Решение осознанное: вся бизнес-логика (какие
// напоминания просрочены, кому их слать, работа с секретами через
// SecretsService) остаётся в TypeScript-слое, тестируется тем же
// способом, что весь остальной проект — не дублируется хрупкой SQL-
// логикой внутри cron-джобы, которую сложнее тестировать и поддерживать.
//
// ЧЕСТНАЯ ГРАНИЦА ЭТОГО ПРОХОДА — реализованы: модель данных,
// dispatchDueReminders() (логика "кому и когда слать", полностью
// протестирована), клиент Telegram (Пункт 50, telegram-bot-client.ts),
// SQL-файл с инструкцией по настройке pg_cron+pg_net (Пункт 50,
// prisma/manual-migrations/pg_cron_reminders.sql). НЕ реализовано и не
// может быть реализовано в этой среде: сама настройка pg_cron-джобы
// в вашем Supabase (нет сети, нет доступа к живому инстансу) — файл
// с инструкцией явно это фиксирует, не притворяется, что всё готово
// "под ключ" без вашего участия.
//
// АУТЕНТИФИКАЦИЯ ВНУТРЕННЕГО ЭНДПОИНТА — не TelegramAuthGuard (это
// server-to-server вызов от pg_net, не запрос от пользователя Telegram)
// — отдельный секрет (SCHEDULER_DISPATCH_SECRET) через тот же
// SecretsService, тот же класс решения, что уже применялся к
// TELEGRAM_BOT_TOKEN/SERPAPI_KEY, сверяется в контроллере.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sendTelegramMessage, TelegramSendError } from '../common/telegram-bot-client';
import { assertProjectOwnership } from '../common/project-ownership';
import { SparringService } from '../sparring/sparring.service';

export interface CreateScheduledConversationInput {
  personId?: string;
  scheduledAt: Date;
  sparringReminderMinutesBefore?: number | null;
}

@Injectable()
export class SchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sparring: SparringService,
  ) {}

  async create(userId: string, projectId: string, input: CreateScheduledConversationInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.scheduledConversation.create({
      data: {
        projectId,
        personId: input.personId ?? null,
        scheduledAt: input.scheduledAt,
        sparringReminderMinutesBefore: input.sparringReminderMinutesBefore ?? null,
      },
    });
  }

  /** "Вид 'сегодня/завтра/послезавтра'... и 'последняя неделя'"
   * (§3.20 ТЗ) — один список, отсортированный по scheduledAt,
   * TMA-слой сам группирует по датам для отображения (не дублируем
   * логику дат календаря на backend, где ей естественнее место в UI). */
  async listForProject(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.scheduledConversation.findMany({
      where: { projectId },
      include: { person: true, linkedConversation: true },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /** Явное действие пользователя, не угадывается системой — см.
   * обоснование над linkedConversationId в schema.prisma. */
  async linkToConversation(userId: string, scheduledId: string, conversationId: string) {
    const scheduled = await this.findOwned(userId, scheduledId);
    return this.prisma.scheduledConversation.update({
      where: { id: scheduled.id },
      data: { linkedConversationId: conversationId },
    });
  }

  /** Вызывается ТОЛЬКО через SchedulerController.dispatch(), после
   * проверки SCHEDULER_DISPATCH_SECRET — не публичный, не для прямого
   * вызова пользователем. Возвращает сводку для наблюдаемости
   * (сколько отправлено/сколько упало), не бросает исключение на
   * отдельном сбое отправки — одно недоставленное напоминание не
   * должно останавливать обработку остальных. */
  async dispatchDueReminders(botToken: string): Promise<{ sparringSent: number; postMortemSent: number; failed: number }> {
    const now = new Date();
    let sparringSent = 0;
    let postMortemSent = 0;
    let failed = 0;

    const dueSparring = await this.prisma.scheduledConversation.findMany({
      where: {
        sparringReminderSentAt: null,
        sparringReminderMinutesBefore: { not: null },
      },
      include: { project: { include: { owner: true } }, person: true },
    });
    for (const s of dueSparring) {
      const reminderTime = new Date(s.scheduledAt.getTime() - (s.sparringReminderMinutesBefore as number) * 60_000);
      if (reminderTime > now) continue; // ещё не время
      if (s.scheduledAt < now) continue; // разговор уже прошёл — напоминание "заранее" больше не актуально, не слать задним числом

      const personLabel = s.person?.displayName ? ` с ${s.person.displayName}` : '';
      const text = `Через ${s.sparringReminderMinutesBefore} мин. у вас запланирован разговор${personLabel}. Хотите пройти режим «Адвокат дьявола» для подготовки?`;
      try {
        await sendTelegramMessage(botToken, s.project.owner.telegramId, text);
        await this.prisma.scheduledConversation.update({ where: { id: s.id }, data: { sparringReminderSentAt: now } });
        sparringSent++;

        // Пункт 90 (§3.26 ТЗ) — предзаготовка открывающей реплики
        // именно в момент отправки напоминания, не сразу при
        // планировании (см. обоснование в schema.prisma). Сбой
        // предзаготовки НЕ должен считаться сбоем самого напоминания
        // — сообщение пользователю уже доставлено и sparringSent уже
        // засчитан выше; preGenerateSparringOpener() сама честно
        // проглатывает свои внутренние ошибки, здесь дополнительный
        // try/catch на случай непредвиденного исключения снаружи её.
        try {
          await this.sparring.preGenerateSparringOpener(s.id, s.project.ownerId);
        } catch {
          // не критично — обычный startSession() сгенерирует реплику при реальном старте спарринга
        }
      } catch (err) {
        if (err instanceof TelegramSendError) {
          failed++;
          continue; // не останавливаем обработку остальных из-за одного сбоя (например, пользователь заблокировал бота)
        }
        throw err;
      }
    }

    const duePostMortem = await this.prisma.scheduledConversation.findMany({
      where: { postMortemReminderSentAt: null, scheduledAt: { lt: now } },
      include: { project: { include: { owner: true } }, person: true },
    });
    for (const s of duePostMortem) {
      const personLabel = s.person?.displayName ? ` с ${s.person.displayName}` : '';
      const text = `Разговор${personLabel} состоялся — самое время загрузить запись/резюме и провести постфактум-разбор, пока детали свежи.`;
      try {
        await sendTelegramMessage(botToken, s.project.owner.telegramId, text);
        await this.prisma.scheduledConversation.update({ where: { id: s.id }, data: { postMortemReminderSentAt: now } });
        postMortemSent++;
      } catch (err) {
        if (err instanceof TelegramSendError) {
          failed++;
          continue;
        }
        throw err;
      }
    }

    return { sparringSent, postMortemSent, failed };
  }

  private async findOwned(userId: string, scheduledId: string) {
    const scheduled = await this.prisma.scheduledConversation.findUnique({
      where: { id: scheduledId },
      include: { project: true },
    });
    if (!scheduled || scheduled.project.ownerId !== userId) {
      throw new NotFoundException(`ScheduledConversation ${scheduledId} not found`);
    }
    return scheduled;
  }
}
