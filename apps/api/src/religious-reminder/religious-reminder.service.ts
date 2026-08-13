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
import { ReligiousReminderFrequency } from '@prisma/client';

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
  constructor(private readonly prisma: PrismaService) {}

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
    if (user.religiousReminderFrequency === ReligiousReminderFrequency.OFF) {
      return { shouldShow: false, principles: null };
    }
    if (user.religiousReminderFrequency === ReligiousReminderFrequency.ONCE_PER_DAY && user.religiousReminderLastShownAt) {
      // Упрощённое сравнение "тот же календарный день по UTC" — без
      // учёта часового пояса пользователя, тот же класс упрощения,
      // что уже применялся к другим датовым сравнениям в проекте,
      // честно не решает проблему полностью для пользователей рядом
      // с полуночью по местному времени.
      const lastShownDate = user.religiousReminderLastShownAt.toISOString().slice(0, 10);
      const todayDate = new Date().toISOString().slice(0, 10);
      if (lastShownDate === todayDate) {
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
