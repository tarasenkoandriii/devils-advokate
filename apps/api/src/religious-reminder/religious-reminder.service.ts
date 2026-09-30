// Пункт 68: ReligiousReminderService (§3.24 ТЗ, "Ежедневное
// религиозное напоминание") — недостающая часть §3.24, честно не
// реализованная в Пункте 64 (та фича закрыла только контекстные
// цитаты/анекдоты по кнопке, §3.25 — другая механика, сама ТЗ прямо
// это разделяет: "Настройка независима от частоты религиозного
// напоминания — это разные механики").
//
// СТАТИЧЕСКИЙ СПРАВОЧНИК, НЕ AI-ГЕНЕРАЦИЯ — принципиальное отличие от
// Пункта 64 (контекстная цитата/анекдот ПОД СИТУАЦИЮ проекта требовала
// AI). Здесь содержание ФИКСИРОВАНО (десять заповедей, пять столпов
// ислама и т.д.) и не зависит от ситуации — повторная AI-генерация
// одного и того же фиксированного содержания рисковала бы дрейфом
// формулировок между вызовами и была бы неоправданным расходом на
// внешний API ради контента, который не меняется. Один раз
// вручную сформулированный, проверенный краткий парафраз надёжнее.
//
// ДИСЦИПЛИНА ЦИТИРОВАНИЯ — та же, что уже применена в §3.14
// (ReconciliationArgumentsService, Пункт 49): краткий парафраз своими
// словами, не дословное цитирование длинного отрывка первоисточника.
//
// "РАСШИРЯЕМЫЙ СПРАВОЧНИК ПО religionId" (буквально ТЗ) — ключи
// справочника СОВПАДАЮТ буквально с RELIGION_OPTIONS во
// OnboardingForm.tsx (тот же контролируемый список значений, что уже
// использует онбординг, User.religion не полностью свободный текст).
// "Другое" НАМЕРЕННО ОТСУТСТВУЕТ В СПРАВОЧНИКЕ — нет конкретной
// традиции, к которой можно честно сослаться, показывать что-либо
// произвольное было бы домыслом.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';
import { ReligiousReminderFrequency } from '@prisma/client';

/** «Раз в день» как окно, а не календарные сутки: 20 часов — см. разбор в
 * shouldShow(). Экспортируется ради теста. */
export const REMINDER_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

const RELIGIOUS_PRINCIPLES: Record<string, string[]> = {
  Христианство: [
    'Верность единому Богу',
    'Не создавать себе кумиров',
    'Не произносить имя Бога напрасно',
    'Помнить о дне покоя',
    'Почитать родителей',
    'Не убивать',
    'Хранить верность в браке',
    'Не красть',
    'Не лжесвидетельствовать',
    'Не желать чужого',
  ],
  Ислам: [
    'Шахада — свидетельство веры в единого Бога',
    'Салят — молитва пять раз в день',
    'Закят — обязательная забота о нуждающихся',
    'Саум — пост в месяц Рамадан',
    'Хадж — паломничество в Мекку при возможности',
  ],
  Иудаизм: [
    'Единство Бога',
    'Изучение Торы',
    'Соблюдение субботы (Шаббат)',
    'Забота о справедливости и милосердии (цдака)',
    'Этичное поведение по отношению к ближнему',
  ],
  Буддизм: [
    'Жизнь неразрывно связана со страданием',
    'У страдания есть причина — привязанность и желание',
    'Страдание можно прекратить',
    'К этому ведёт восьмеричный путь — верные взгляды, намерения, речь и поступки',
  ],
};

export interface ReminderResult {
  shouldShow: boolean;
  principles: string[] | null;
}

@Injectable()
export class ReligiousReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  /** Проверяет, нужно ли показать напоминание СЕЙЧАС, и если да —
   * отмечает момент показа (для логики ONCE_PER_DAY). Вызывается
   * клиентом при открытии приложения — тот же "проверка при заходе",
   * не push-уведомление (в проекте нет push-инфраструктуры вне
   * pg_cron-напоминаний планировщика, Пункт 50). */
  async getReminderIfDue(userId: string): Promise<ReminderResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { religion: true, religiousReminderFrequency: true, religiousReminderLastShownAt: true },
    });

    if (!user?.religion || !(user.religion in RELIGIOUS_PRINCIPLES)) {
      return { shouldShow: false, principles: null };
    }
    // Пункт [the-consent-that-stopped-nothing] 2026-09-30: гейтом было
    // ТОЛЬКО поле `religion`, а отзыв согласия на религиозный контент
    // его не касался — напоминания приходили и после отзыва.
    if (!(await this.consent.hasActiveConsent(userId, ConsentType.RELIGIOUS_CONTENT))) {
      return { shouldShow: false, principles: null };
    }
    if (user.religiousReminderFrequency === ReligiousReminderFrequency.OFF) {
      return { shouldShow: false, principles: null };
    }
    if (user.religiousReminderFrequency === ReligiousReminderFrequency.ONCE_PER_DAY && user.religiousReminderLastShownAt) {
      // Аудит времени 2026-09-03. Здесь сравнивались календарные дни ПО UTC
      // — и в старом комментарии честно говорилось, что для человека рядом
      // с местной полуночью это не работает. Что именно он видел: показ в
      // 23:50 и второй в 00:10, через двадцать минут, — «раз в день»
      // превращалось в «дважды за вечер». Часового пояса у пользователя в
      // продукте нет, и заводить его ради напоминания незачем.
      //
      // Поэтому окно, а не календарь: с последнего показа должно пройти
      // не меньше REMINDER_MIN_INTERVAL_MS. Двадцать часов, не двадцать
      // четыре, — из-за дрейфа: при ровно суточном пороге человек,
      // открывающий приложение каждое утро примерно в одно время, каждый
      // день попадал бы чуть раньше порога и в итоге пропускал день.
      const sinceLastMs = Date.now() - user.religiousReminderLastShownAt.getTime();
      if (sinceLastMs < REMINDER_MIN_INTERVAL_MS) {
        return { shouldShow: false, principles: null };
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { religiousReminderLastShownAt: new Date() } });
    return { shouldShow: true, principles: RELIGIOUS_PRINCIPLES[user.religion] };
  }

  async updateFrequency(userId: string, frequency: ReligiousReminderFrequency) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { religiousReminderFrequency: frequency },
      select: { religiousReminderFrequency: true },
    });
  }
}
