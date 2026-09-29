// Сверка 2026-09-05 — обещано, что придёт.
//
// НАЙДЕННОЕ. Экран планировщика писал под каждой встречей с
// напоминанием: «напоминание о спарринге ЗАПЛАНИРОВАНО». Это
// утверждение о будущем, а доставка держится на том, чего в самом
// продукте нет: pg_cron + pg_net, настроенные владельцем ВРУЧНУЮ в
// Supabase (файл миграции честно говорит, что настройка за ним), плюс
// секрет диспетчеризации и токен бота. Не настроено что-нибудь одно —
// не приходит НИЧЕГО, а экран продолжает писать «запланировано» и до
// разговора, и после него. Человек строит подготовку вокруг
// напоминания, которого не будет.
//
// ЧТО МОЖНО ЗНАТЬ БЕЗ НОВОЙ КОЛОНКИ. Ничего записывать не надо: момент
// напоминания вычисляется из уже сохранённых полей. Прошёл, а отметки
// об отправке нет — напоминание НЕ УШЛО. Это факт об этой встрече, а не
// догадка о чужих настройках.
//
// ПОЧЕМУ НЕ ПРОВЕРКА «ЖИВ ЛИ КРОН». Ей нужно место под отметку
// последнего тика, то есть ПЯТАЯ ручная миграция — их и так четыре ждут
// применения. Решение о пятой за владельцем; вычисляемого признака
// достаточно, чтобы человек перестал ждать несуществующего сообщения.
//
// ВТОРОЕ ТАКОЕ ЖЕ ОБЕЩАНИЕ — в настройках: «Ежедневное напоминание о
// заповедях/столпах веры» с выбором частоты. Напоминание — то, что
// приходит само; push-доставки у этой функции нет вовсе, показ
// происходит при открытии приложения, и её собственный комментарий это
// говорит прямо. Исправлено там же (экранная половина сверки).

import { readFileSync } from 'fs';
import { join } from 'path';
import { reminderState, reminderDueAt } from '../scheduler/reminder-state';

const API_SRC = join(__dirname, '..');
const TMA_SRC = join(API_SRC, '../../tma/src');

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = new Date('2026-09-05T12:00:00Z');
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);

describe('[promised-arrival] «запланировано» не говорится о том, что уже не ушло', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: момент прошёл, отметки нет — напоминание НЕ УШЛО', () => {
    // Это и есть весь пункт. До сверки экран писал «запланировано» и
    // здесь тоже — вплоть до самого разговора и после него.
    const overdue = { scheduledAt: at(30), sparringReminderMinutesBefore: 60, sparringReminderSentAt: null };
    expect(reminderState(overdue, NOW)).toBe('overdue');
    // И названо, КОГДА оно должно было уйти: «просрочено» без времени —
    // утверждение, которое человеку нечем проверить.
    expect(reminderDueAt(overdue)).toEqual(at(-30));
  });

  it('КЛЮЧЕВОЙ ТЕСТ: будущее напоминание по-прежнему «запланировано»', () => {
    // Обратная сторона: пометка «не ушло» на том, чей момент ещё не
    // наступил, — такой же обман, только в другую сторону. Мутация
    // «всегда overdue» обязана падать здесь.
    expect(reminderState({ scheduledAt: at(120), sparringReminderMinutesBefore: 60, sparringReminderSentAt: null }, NOW)).toBe('scheduled');
    // Ровно в момент — уже пора: граница включительная, иначе минута,
    // на которую крон опоздал, читалась бы как «ещё не время».
    expect(reminderState({ scheduledAt: at(60), sparringReminderMinutesBefore: 60, sparringReminderSentAt: null }, NOW)).toBe('overdue');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отправленное остаётся отправленным, непрошеное — непрошеным', () => {
    expect(reminderState({ scheduledAt: at(-500), sparringReminderMinutesBefore: 60, sparringReminderSentAt: at(-560) }, NOW)).toBe('sent');
    expect(reminderState({ scheduledAt: at(120), sparringReminderMinutesBefore: null, sparringReminderSentAt: null }, NOW)).toBe('not-requested');
    expect(reminderDueAt({ scheduledAt: at(120), sparringReminderMinutesBefore: null, sparringReminderSentAt: null })).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: состояние считает СЕРВЕР, а не экран', () => {
    // Экран, решающий это сам, однажды решит иначе, чем диспетчер: у
    // него другие часы и другое представление о «прошло».
    const service = code(join(API_SRC, 'scheduler/scheduler.service.ts'));
    expect(service).toMatch(/reminderState: reminderState\(r, now\)/);
    expect(service).toMatch(/reminderDueAt: reminderDueAt\(r\)/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран говорит, что напоминание не ушло, и чего от него не ждать', () => {
    const note = code(join(TMA_SRC, 'components/ReminderNote.tsx'));
    expect(note).toMatch(/напоминание не ушло/);
    expect(note).toMatch(/не рассчитывайте/);
    // Объявляемое: строка появляется сама, человек на неё не смотрел.
    expect(note).toMatch(/role="status"/);
    // И прежнее безусловное обещание больше не единственный вариант.
    const section = code(join(TMA_SRC, 'components/SchedulerSection.tsx'));
    expect(section).toMatch(/<ReminderNote\b/);
    expect(section).not.toMatch(/sparringReminderSentAt \? '✓/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: показ при входе больше не называется ежедневным напоминанием', () => {
    // Второе обещание того же рода: напоминание — то, что приходит
    // само. Push-доставки у этой функции нет вовсе.
    const settings = code(join(TMA_SRC, 'app/settings/page.tsx'));
    expect(settings).not.toMatch(/Ежедневное напоминание/);
    expect(settings).toMatch(/при открытии приложения/i);
    expect(settings).toMatch(/если не зайти, ничего не придёт/);
    // «Раз в день» читалось как расписание доставки; это потолок показов.
    expect(settings).toMatch(/Не чаще раза в день/);
  });

  it('ИЗМЕРЕНИЕ: сколько в продукте обещаний доставки и все ли оговорены', () => {
    // Точка отсчёта. Доставка наружу у продукта одна — Telegram-бот
    // через диспетчер; всё остальное показывается в приложении.
    // Третье место, обещающее приход, должно быть видно.
    const service = code(join(API_SRC, 'scheduler/scheduler.service.ts'));
    expect(service).toMatch(/sendTelegramMessage\(/);
    const senders = ['scheduler/scheduler.service.ts'];
    for (const rel of senders) expect(code(join(API_SRC, rel))).toMatch(/sendTelegramMessage/);
    // Религиозный показ доставкой НЕ пользуется — это и есть причина,
    // по которой называть его напоминанием было нельзя.
    const religious = code(join(API_SRC, 'religious-reminder/religious-reminder.service.ts'));
    expect(religious).not.toMatch(/sendTelegramMessage/);
  });
});
