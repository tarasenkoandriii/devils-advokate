'use client';

// Пункт 68 (backend) → TMA UI: ежедневное религиозное напоминание
// (§3.24 ТЗ). Намеренно маленький изолированный компонент,
// вставляется одной строкой в главную страницу — "проверка при
// открытии приложения", не push-уведомление (в проекте нет
// push-инфраструктуры вне pg_cron-напоминаний планировщика).
// Полностью самодостаточен: если показывать нечего (нет
// вероисповедания, выключено, уже показано сегодня) — рендерит null,
// не требует никакой логики от компонента-хозяина.

import { useEffect, useState } from 'react';
import { getReligiousReminderIfDue } from '../lib/features';

export function ReligiousReminderBanner() {
  const [principles, setPrinciples] = useState<string[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    getReligiousReminderIfDue()
      .then((result) => {
        if (result.shouldShow) setPrinciples(result.principles);
      })
      .catch(() => {});
  }, []);

  if (!principles || dismissed) return null;

  return (
    <div className="religious-reminder-banner">
      <ul>
        {principles.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
      <button type="button" onClick={() => setDismissed(true)}>
        Скрыть
      </button>
    </div>
  );
}
