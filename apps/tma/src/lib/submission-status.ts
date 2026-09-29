// Пункт [own-submission] 2026-09-04 — что человек узнаёт о судьбе того,
// что сам отправил.
//
// НАЙДЕНО. Экран отправки в библиотеку говорил человеку: «уже отправлен
// в публичную библиотеку — ожидает модерации ИЛИ УЖЕ ОПУБЛИКОВАН». Два
// исхода из трёх; отсутствовал ровно один — отклонение, единственный
// плохой. И проверить было нечем: `submittedByUserId` записывался при
// создании и не читался нигде во всём проекте.
//
// Соседняя ветка продукта делает это правильно: публичное обсуждение
// показывает участнику статус его заявки словами — «на рассмотрении у
// автора», «принято», «отклонено». Правило было, просто не везде.
//
// ПРИЧИНЫ ОТКЛОНЕНИЯ У ПРОДУКТА НЕТ. Модерация её не записывает: колонки
// под неё нет ни у записи библиотеки, ни у заявки заведения. Здесь это
// сказано человеку прямо, а не заменено пустотой или бодрым «свяжитесь с
// нами»: пробел в продукте не должен выглядеть как отсутствие причины у
// решения. Появится колонка — появится и текст причины, а до тех пор
// врать не о чем.

import type { LibraryModerationStatus, VenueApplicationStatus } from './types';

export interface SubmissionOutcome {
  /** Короткое слово для строки списка. */
  label: string;
  /** Что это значит и чего продукт про это НЕ знает. */
  detail: string;
  /** Решение принято и обратного хода в продукте нет. */
  decided: boolean;
}

/** Дата решения человеческим текстом; пустая, если её нет. Дата,
 * которой нет, лучше отсутствует, чем показана как «Invalid Date» — тот
 * же приём, что в сообщениях модерации аккаунта. */
export function decidedOn(moment: string | null | undefined): string {
  if (!moment) return '';
  const d = new Date(moment);
  if (Number.isNaN(d.getTime())) return '';
  return ` ${d.toLocaleDateString('ru-RU', { dateStyle: 'medium' })}`;
}

const NO_REASON =
  'Причина не указана: продукт её не сохраняет — модерация решение не поясняет. ' +
  'Придумывать причину за неё мы не будем.';

export function librarySubmissionOutcome(
  status: LibraryModerationStatus,
  moderatedAt: string | null,
): SubmissionOutcome {
  switch (status) {
    case 'ACCEPTED':
      return {
        label: `Опубликовано${decidedOn(moderatedAt)}`,
        detail: 'Запись видна в публичной библиотеке — это снимок текста аргументов на момент отправки, ' +
          'он не меняется вслед за вашим проектом.',
        decided: true,
      };
    case 'REJECTED':
      return {
        label: `Отклонено${decidedOn(moderatedAt)}`,
        // Обязательная вторая половина: что отклонение НЕ делает.
        detail: `${NO_REASON} Ваш проект и его аргументы не тронуты — отклонена только публикация. ` +
          'Отправить этот же проект повторно продукт не даёт.',
        decided: true,
      };
    default:
      return {
        label: 'На рассмотрении',
        detail: 'Решения пока нет. Сроков продукт не обещает — их в нём не заложено.',
        decided: false,
      };
  }
}

export function venueApplicationOutcome(
  status: VenueApplicationStatus,
  moderatedAt: string | null,
): SubmissionOutcome {
  switch (status) {
    case 'APPROVED':
      return {
        label: `Одобрено${decidedOn(moderatedAt)}`,
        detail: 'Заведение опубликовано в каталоге — карточка собрана из данных на момент одобрения.',
        decided: true,
      };
    case 'REJECTED':
      return {
        label: `Отклонено${decidedOn(moderatedAt)}`,
        detail: `${NO_REASON} Заявка сохранена — заведение просто не попало в каталог.`,
        decided: true,
      };
    default:
      return {
        label: 'На рассмотрении',
        detail: 'Решения пока нет. Сроков продукт не обещает — их в нём не заложено.',
        decided: false,
      };
  }
}
