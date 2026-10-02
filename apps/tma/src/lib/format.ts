// Пункт [the-formatter-lived-in-someone-elses-domain] 2026-10-01 —
// общие форматтеры переехали из домена ДТП в общее место.
//
// НАЙДЕНО СРЕЗОМ ПРО ВЫДЕЛЕНИЕ МОДУЛЯ НАЙМА. Связность job-экранов с
// остальным продуктом оказалась практически нулевой — одно
// единственное продуктовое ребро, и это оно: `money` и `dateTime`
// импортировались из `components/domains/dtp/dtp-types`, то есть из
// домена «ДТП». Так делают СЕМЬ не-ДТП рабочих экранов, не только
// найм.
//
// Само по себе это не дефект поведения — числа и даты форматируются
// верно. Но это ребро, из-за которого любой разговор про «вынести
// домен» начинается с распутывания, а не с дела: формат денег не
// принадлежит ДТП, он принадлежит продукту. Правка дешёвая и полезна
// независимо от того, случится выделение или нет.
//
// `dtp-types` реэкспортирует эти имена, чтобы ни один существующий
// импорт не ломался, а доменные подписи (`FAULT_SOURCE_LABEL` и
// прочее) остались там, где и должны — в своём домене.

/** Денежная сумма с валютой. `—` вместо пустоты: пустая ячейка читается
 *  как «ноль», а это разные вещи. */
export function money(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '—';
  return `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency ?? ''}`.trim();
}

/** Дата со временем. Считает УСТРОЙСТВО человека — только оно знает его
 *  часовой пояс (правило [server-said-which-day]). */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/** Только дата, по тому же правилу. */
export function dateOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('ru-RU', { dateStyle: 'medium' }) : '—';
}
