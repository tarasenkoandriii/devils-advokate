'use client';

// Пункт [one-buzz-was-the-whole-answer] 2026-09-24 — общее объявление о
// неудаче действия. Одно на всё приложение: см. разбор в
// `lib/failure-report.ts`.
//
// `role="alert"` — не украшение: программа чтения с экрана произносит
// такое сообщение сама, без перехода к нему. Для отказа, о котором
// человек узнаёт вместо вибрации, это и есть смысл.
//
// Закрывается рукой, а не по таймеру: отказ, исчезнувший сам, — это
// снова «нажал и не узнал», только с задержкой.

import { useEffect, useState } from 'react';
import { Failure, subscribeFailures } from '../lib/failure-report';

export function FailureAnnouncer() {
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => subscribeFailures(setFailure), []);

  if (!failure) return null;
  return (
    <div className="failure-announcer" role="alert">
      <div className="failure-announcer__body">
        <strong>{failure.action}</strong>
        {failure.reason && <span className="failure-announcer__reason">{failure.reason}</span>}
      </div>
      <button type="button" className="failure-announcer__close" onClick={() => setFailure(null)} aria-label="Закрыть сообщение">
        ×
      </button>
    </div>
  );
}
