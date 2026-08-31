'use client';

// Фаза F — отчёт по intake-квизу: статусы, средняя уверенность, число
// уточнений и матрица «AI предложил × пользователь выбрал» — то, что
// даёт сигнал для калибровки классификатора (ТЗ §2.2 п.6).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getIntakeSummary } from '../../lib/endpoints';
import type { IntakeSummary } from '../../lib/types';

export default function IntakeAdminPage() {
  const [data, setData] = useState<IntakeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getIntakeSummary().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!data) return <div className="page"><p className="muted">Загрузка…</p></div>;
  const scenarios = Array.from(new Set([...Object.keys(data.suggestedVsChosen), ...Object.values(data.suggestedVsChosen).flatMap((r) => Object.keys(r))])).sort();
  return (
    <div className="page">
      <p><Link href="/domains">← Сценарии</Link></p>
      <h1>Intake-квиз · {data.windowDays} дней</h1>
      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div><div className="muted">Сессий</div><strong>{data.total}</strong></div>
        {Object.entries(data.byStatus).map(([k, v]) => <div key={k}><div className="muted">{k}</div><strong>{v}</strong></div>)}
        <div><div className="muted">Ср. уверенность</div><strong>{data.avgConfidence ?? '—'}</strong></div>
        <div><div className="muted">Ср. уточнений</div><strong>{data.avgFollowUps ?? '—'}</strong></div>
        <div><div className="muted">Предложил ≠ выбрал</div><strong className={data.mismatchRate !== null && data.mismatchRate > 0.3 ? 'badge badge-bad' : ''}>{data.mismatches} / {data.dispatched}{data.mismatchRate !== null ? ` (${Math.round(data.mismatchRate * 100)}%)` : ''}</strong></div>
      </div>
      <h2>Предложил (строки) × выбрал (столбцы)</h2>
      <p className="muted">Диагональ — согласие. Крупные значения вне диагонали — классификатор системно путает сценарии; это вход для правки промпта <code>intake-classify</code> в реестре.</p>
      {scenarios.length === 0 ? <p className="muted">Пока нет ни одного dispatch.</p> : (
        <table>
          <thead><tr><th></th>{scenarios.map((s) => <th key={s}>{s}</th>)}</tr></thead>
          <tbody>
            {scenarios.map((sug) => (
              <tr key={sug}><th>{sug}</th>{scenarios.map((ch) => { const v = data.suggestedVsChosen[sug]?.[ch] ?? 0; return <td key={ch} style={sug === ch ? { fontWeight: 600 } : v > 0 ? { color: 'var(--signal-critical)' } : undefined}>{v || ''}</td>; })}</tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
