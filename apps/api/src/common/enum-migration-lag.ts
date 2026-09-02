// Продолжение аудита 2026-09-02 — отставание миграции перечисления.
//
// Класс регрессии, который владелец уже ловил в проде 2026-09-02 утром
// («The column users.languageCode does not exist»): код выкатился раньше,
// чем к базе применили ручную миграцию, и штатная работа выглядела как
// сбой. Сегодня добавлено значение перечисления
// SparringVoiceReplyStatus.PROCESSING (voice_reply_processing_2026_09_02.sql),
// и до его применения любой запрос с этим значением падает в Postgres с
// 22P02 «invalid input value for enum …». Prisma не даёт этому отдельного
// кода (для DDL-расхождений у него P2021/P2022, для значений перечисления
// — нет), ошибка приходит как PrismaClientUnknownRequestError с текстом
// драйвера.
//
// Правило проекта: пробел конфигурации не должен выглядеть как отказ
// функции. Поэтому места, где новое значение используется, распознают
// это отставание и деградируют предсказуемо — с предупреждением в лог и
// с прежним поведением, — а ApiExceptionFilter называет миграцию по
// имени, если ошибка всё же дошла до ответа.

export function isUnknownEnumValueError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /invalid input value for enum/i.test(message) || /\b22P02\b/.test(message);
}

/** Одно предупреждение на процесс на каждую точку — не по строке на каждый вебхук. */
const warned = new Set<string>();

export function warnEnumMigrationLagOnce(logger: { warn(message: string): void }, site: string): void {
  if (warned.has(site)) return;
  warned.add(site);
  logger.warn(
    `${site}: база не знает нового значения перечисления — миграция ` +
      'apps/api/prisma/manual-migrations/voice_reply_processing_2026_09_02.sql не применена. ' +
      'Работаем в прежнем режиме (без атомарного забора / без сторожевой PROCESSING) до её применения.',
  );
}

/** Только для тестов: сбросить память о выданных предупреждениях. */
export function resetEnumMigrationLagWarnings(): void {
  warned.clear();
}
