// ПОВТОРНЫЙ АУДИТ 2026-08-30: сравнение секретов «в постоянное время»
// в проекте уже было — но ровно в одном месте (AssemblyAiWebhookGuard),
// а три server-to-server эндпоинта, которые в проде дёргает pg_cron,
// сравнивали свой секрет обычным `!==`:
//   scheduler.controller.ts   — POST /internal/reminders/dispatch
//   calibration.controller.ts — POST /internal/calibration/recompute
//   intake.controller.ts      — POST /intake/abandon-stale
//
// Практическая эксплуатация тайминга через сеть маловероятна (джиттер
// сети на порядки больше разницы в наносекундах), и главная причина
// вынести функцию сюда — не она, а три копии одной проверки: разъедутся
// они рано или поздно так же, как разъехались проверки согласий.
//
// Строки, а не Buffer, на входе — потому что все три места получают
// значение из заголовка HTTP. Разная длина не доходит до timingSafeEqual
// (он бросает на разных длинах), и это не утечка: длина секрета и так
// не тайна, тайна — его содержимое.

import { timingSafeEqual } from 'crypto';

export function safeSecretEqual(provided: string | undefined | null, expected: string | undefined | null): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
