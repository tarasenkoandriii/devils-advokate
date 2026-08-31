'use client';

// Полный аудит 2026-08-30 — статус калибровочного gate (§5.3). Backend и
// обёртка getCalibrationStatus() существовали, страницы не было: операторы
// не видели, проходит ли gate, а данные для него (confirm-outcome в TMA)
// до того же аудита не поступали вовсе.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getCalibrationStatus } from '../../lib/endpoints';
import type { CalibrationStatus } from '../../lib/types';

export default function CalibrationPage() {
  const [data, setData] = useState<CalibrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getCalibrationStatus().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!data) return <div className="page"><p className="muted">Загрузка…</p></div>;
  const enough = data.sampleSize > 0 && data.brierScore !== null;
  return (
    <div className="page">
      <h1>Калибровка прогнозов</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Brier score по сценариям исхода, которые пользователи отметили как «сбылось / не сбылось» в TMA. Gate
        проходит при score ниже порога — это условие для промоута новых версий промптов (см. <Link href="/prompts">Промпты</Link>).
        Пересчёт — раз в сутки pg_cron (<code>internal/calibration/recompute</code>).
      </p>
      <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div><div className="muted">Подтверждённых исходов</div><strong>{data.sampleSize}</strong></div>
        <div><div className="muted">Brier score</div><strong>{data.brierScore === null ? '—' : data.brierScore.toFixed(3)}</strong></div>
        <div><div className="muted">Порог</div><strong>{data.threshold}</strong></div>
        <div><div className="muted">Gate</div><strong>{!enough ? <span className="badge badge-pending">нет данных</span> : data.gatePassed ? <span className="badge badge-ok">пройден</span> : <span className="badge badge-bad">не пройден</span>}</strong></div>
      </div>
      {!enough && <p className="muted" style={{ marginTop: 16 }}>Данные появятся, когда пользователи начнут отмечать исходы сценариев в проектах. До полного аудита 2026-08-30 такой кнопки в TMA не было — счётчик честно начинается с нуля.</p>}
    </div>
  );
}
