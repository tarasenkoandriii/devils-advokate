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
import { reminderState, reminderDueAt } from './reminder-state';

export interface CreateScheduledConversationInput {
  personId?: string;
  scheduledAt: Date;
  sparringReminderMinutesBefore?: number | null;
}

// Пункт [background-jobs] 2026-09-04 — потолок одного тика. Обе выборки
// ниже были `findMany` без `take` и без `orderBy`: сколько строк подойдёт
// под условие, столько и уедет в память одного вызова, в произвольном
// порядке БД. Крон ходит раз в минуту, поэтому не поместившееся уйдёт
// следующим тиком — задержка в минуту для напоминания «за час до»
// несущественна, а неограниченная выборка рано или поздно кладёт тик
// целиком (и вместе с ним все напоминания, а не одно).
const DISPATCH_BATCH = 50;

// Постфактум-напоминание осмысленно, «пока детали свежи» — так написано
// в самом его тексте. Через неделю это уже не просроченное напоминание,
// а сообщение про разговор, который человек успел забыть.
//
// Окно закрывает и вторую, менее очевидную дыру. При постоянном сбое
// отправки (человек заблокировал бота) отметка снимается обратно в null,
// и строка возвращалась в выборку КАЖДУЮ МИНУТУ НАВСЕГДА: по одной
// бесполезной попытке в минуту на каждый когда-либо прошедший разговор,
// накапливающимся итогом. Окно превращает «вечно» в «неделю».
//
// ЧЕСТНАЯ ГРАНИЦА: это потолок, а не пауза между попытками. Настоящий
// отсчёт попыток («перестать после третьего отказа») требует отдельной
// колонки в БД, то есть ещё одной ручной миграции — их и так четыре
// ждут применения; решение о пятой за владельцем, здесь оно не
// принимается молча.
const POST_MORTEM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  async listForProject(userId: string, projectId: string, now = new Date()) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const rows = await this.prisma.scheduledConversation.findMany({
      where: { projectId },
      include: { person: true, linkedConversation: true },
      orderBy: { scheduledAt: 'asc' },
    });
    // Пункт [promised-arrival] 2026-09-05: экран писал «напоминание
    // запланировано» и тогда, когда момент давно прошёл, а отметки об
    // отправке нет — то есть когда напоминание заведомо не ушло.
    // Считается здесь, из уже сохранённых полей: новой колонки для
    // этого не нужно.
    return rows.map((r) => ({
      ...r,
      reminderState: reminderState(r, now),
      reminderDueAt: reminderDueAt(r),
    }));
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
  async dispatchDueReminders(botToken: string): Promise<{
    sparringSent: number;
    postMortemSent: number;
    failed: number;
    postMortemExpiredTotal: number;
  }> {
    const now = new Date();
    let sparringSent = 0;
    let postMortemSent = 0;
    let failed = 0;

    // Пункт [background-jobs] 2026-09-04: `scheduledAt: { gte: now }`
    // переехало из тела цикла в условие запроса. Раньше строка прошедшего
    // разговора, которой напоминание так и не ушло, оставалась в выборке
    // навсегда (отметка так и null) и отбрасывалась уже в JS — рабочий
    // набор тика рос вместе с возрастом проекта, а не с числом дел.
    // Порядок — ближайшие первыми: именно им напоминание нужно сейчас.
    const dueSparring = await this.prisma.scheduledConversation.findMany({
      where: {
        sparringReminderSentAt: null,
        sparringReminderMinutesBefore: { not: null },
        scheduledAt: { gte: now },
      },
      include: { project: { include: { owner: true } }, person: true },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: DISPATCH_BATCH,
    });
    for (const s of dueSparring) {
      const reminderTime = new Date(s.scheduledAt.getTime() - (s.sparringReminderMinutesBefore as number) * 60_000);
      if (reminderTime > now) continue; // ещё не время

      const personLabel = s.person?.displayName ? ` с ${s.person.displayName}` : '';
      const text = `Через ${s.sparringReminderMinutesBefore} мин. у вас запланирован разговор${personLabel}. Хотите пройти режим «Адвокат дьявола» для подготовки?`;
      // Аудит времени 2026-09-03: отметка «отправлено» ставилась ПОСЛЕ
      // отправки, а выборка шла по `sentAt: null`. Два тика крона внахлёст
      // (минутный крон и подтормозивший предыдущий вызов) выбирали одну и
      // ту же строку и слали человеку два одинаковых напоминания. Тот же
      // приём, что уже применён к аренде медиа: сначала АТОМАРНО забираем
      // право на отправку условным UPDATE, потом шлём.
      const claimed = await this.prisma.scheduledConversation.updateMany({
        where: { id: s.id, sparringReminderSentAt: null },
        data: { sparringReminderSentAt: now },
      });
      if (claimed.count === 0) continue; // забрал другой тик
      try {
        await sendTelegramMessage(botToken, s.project.owner.telegramId, text);
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
        // Отправка не удалась — отметку снимаем: пропущенное напоминание
        // перед реальным разговором дороже лишнего запроса на следующем
        // тике. Дубль при этом невозможен: пока отметка стояла, вторая
        // копия строку не выбрала.
        await this.prisma.scheduledConversation.updateMany({
          where: { id: s.id, sparringReminderSentAt: now },
          data: { sparringReminderSentAt: null },
        });
        if (err instanceof TelegramSendError) {
          failed++;
          continue; // не останавливаем обработку остальных из-за одного сбоя (например, пользователь заблокировал бота)
        }
        throw err;
      }
    }

    // Окно вместо «всё, что когда-либо прошло» — см. POST_MORTEM_WINDOW_MS.
    // Порядок — свежие первыми: если порции не хватило, разбирается то,
    // что человеку ещё интересно, а не разговор недельной давности.
    const postMortemWindowStart = new Date(now.getTime() - POST_MORTEM_WINDOW_MS);
    const duePostMortem = await this.prisma.scheduledConversation.findMany({
      where: {
        postMortemReminderSentAt: null,
        scheduledAt: { lt: now, gte: postMortemWindowStart },
      },
      include: { project: { include: { owner: true } }, person: true },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: DISPATCH_BATCH,
    });
    for (const s of duePostMortem) {
      const personLabel = s.person?.displayName ? ` с ${s.person.displayName}` : '';
      const text = `Разговор${personLabel} состоялся — самое время загрузить запись/резюме и провести постфактум-разбор, пока детали свежи.`;
      // Тот же захват права на отправку, что у напоминания о спарринге выше.
      const claimedPostMortem = await this.prisma.scheduledConversation.updateMany({
        where: { id: s.id, postMortemReminderSentAt: null },
        data: { postMortemReminderSentAt: now },
      });
      if (claimedPostMortem.count === 0) continue;
      try {
        await sendTelegramMessage(botToken, s.project.owner.telegramId, text);
        postMortemSent++;
      } catch (err) {
        await this.prisma.scheduledConversation.updateMany({
          where: { id: s.id, postMortemReminderSentAt: now },
          data: { postMortemReminderSentAt: null },
        });
        if (err instanceof TelegramSendError) {
          failed++;
          continue;
        }
        throw err;
      }
    }

    // То, что выпало за окно и не будет отправлено никогда, — считается и
    // называется. Без этой строки потеря выглядела бы как «напоминать
    // было нечего»: ровно та форма, которую этот заход и разбирает.
    // ЭТО НАКОПИТЕЛЬНЫЙ ИТОГ, не прирост за тик: отдельной отметки
    // «просрочено» в БД нет (см. честную границу у POST_MORTEM_WINDOW_MS),
    // поэтому число считается заново каждый раз и может только расти.
    const postMortemExpiredTotal = await this.prisma.scheduledConversation.count({
      where: { postMortemReminderSentAt: null, scheduledAt: { lt: postMortemWindowStart } },
    });

    return { sparringSent, postMortemSent, failed, postMortemExpiredTotal };
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
