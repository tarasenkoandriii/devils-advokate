'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getTelemetrySummary, getTelemetryByModel } from '../../lib/endpoints';
import { TelemetryChart } from '../../components/TelemetryChart';
import type { TelemetrySummaryRow, TelemetryByModelRow } from '../../lib/types';

function last24hIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export default function TelemetryPage() {
  // Аудит 2026-09-01: поля дат и ПРИМЕНЁННЫЙ диапазон разделены.
  // Раньше эффект грузил данные один раз с подавленным exhaustive-deps;
  // после включения линтера стало видно, что load() замыкает from/to и
  // без разделения кнопка «Обновить» либо тянула бы стартовый диапазон,
  // либо каждое движение в поле даты било бы в API двумя запросами.
  const [from, setFrom] = useState(last24hIso());
  const [to, setTo] = useState(new Date().toISOString());
  const [applied, setApplied] = useState({ from: from, to: to });
  const [summary, setSummary] = useState<TelemetrySummaryRow[] | null>(null);
  const [byModel, setByModel] = useState<TelemetryByModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        getTelemetrySummary(applied.from, applied.to),
        getTelemetryByModel(applied.from, applied.to),
      ]);
      setSummary(s);
      setByModel(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить телеметрию');
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Телеметрия</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Операционная видимость по уже накопленным данным AIJob (devils-advocate-telemetry-tz.md) —
        не учёт стоимости в деньгах, это сознательно вне объёма (см. TODO.md).
      </p>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ fontSize: 12 }} className="muted">
          С
          <input
            type="datetime-local"
            style={{ marginLeft: 6 }}
            value={from.slice(0, 16)}
            onChange={(e) => setFrom(new Date(e.target.value).toISOString())}
          />
        </label>
        <label style={{ fontSize: 12 }} className="muted">
          По
          <input
            type="datetime-local"
            style={{ marginLeft: 6 }}
            value={to.slice(0, 16)}
            onChange={(e) => setTo(new Date(e.target.value).toISOString())}
          />
        </label>
        <button className="btn btn-primary" onClick={() => setApplied({ from, to })}>
          Обновить
        </button>
      </div>

      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>По фиче (taskType)</h2>
        {!summary && <p className="muted">Загрузка…</p>}
        {summary && summary.length === 0 && <p className="muted">Нет вызовов за выбранный период.</p>}
        {summary && summary.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Фича</th>
                <th>Вызовов</th>
                <th>Успех / провал / таймаут / отмена</th>
                <th>Ср. длительность</th>
                <th>p95</th>
                <th>Retry rate</th>
                <th>Fail валидации</th>
                <th>Заблокировано на входе</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.taskType ?? '__null__'}>
                  <td>
                    {row.taskType ? (
                      <Link href={`/telemetry/${encodeURIComponent(row.taskType)}`}>{row.taskType}</Link>
                    ) : (
                      <span className="muted">(до появления поля taskType)</span>
                    )}
                  </td>
                  <td>{row.totalCalls}</td>
                  <td className="muted">
                    {row.byStatus.COMPLETED} / {row.byStatus.FAILED} / {row.byStatus.TIMEOUT} / {row.byStatus.CANCELLED}
                  </td>
                  <td>{row.avgDurationMs != null ? `${Math.round(row.avgDurationMs)} мс` : '—'}</td>
                  <td>{row.p95DurationMs != null ? `${Math.round(row.p95DurationMs)} мс` : '—'}</td>
                  <td>{(row.retryRate * 100).toFixed(1)}%</td>
                  <td>{(row.schemaValidationFailRate * 100).toFixed(1)}%</td>
                  <td>{row.inputBlockedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>По модели / провайдеру</h2>
        {!byModel && <p className="muted">Загрузка…</p>}
        {byModel && byModel.length > 0 && (
          <TelemetryChart
            bars={byModel.map((m) => ({
              label: m.modelVersion,
              value: m.byStatus.FAILED + m.byStatus.TIMEOUT,
              colorVar: '--signal-critical',
            }))}
            unit=" сбоев"
          />
        )}
      </section>
    </div>
  );
}
