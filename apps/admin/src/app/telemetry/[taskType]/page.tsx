'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { getTelemetryTaskDetail } from '../../../lib/endpoints';
import type { AIJobDetail } from '../../../lib/types';

const STATUS_OPTIONS = ['', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'RUNNING', 'QUEUED'];

export default function TelemetryTaskDetailPage() {
  const params = useParams<{ taskType: string }>();
  const taskType = decodeURIComponent(params.taskType);

  const [status, setStatus] = useState('');
  const [jobs, setJobs] = useState<AIJobDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await getTelemetryTaskDetail(taskType, 50, status || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить вызовы');
    }
  }, [taskType, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>{taskType}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Последние 50 вызовов этой фичи. Не показывает output/partialResult — это про паттерны across
        many calls, не про содержимое одного вызова (ТЗ §4.2).
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12 }} className="muted">
          Статус:{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s || 'все'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!jobs && <p className="muted">Загрузка…</p>}
      {jobs && jobs.length === 0 && <p className="muted">Нет вызовов с такими параметрами.</p>}
      {jobs && jobs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Статус</th>
              <th>Модель</th>
              <th>Повторов</th>
              <th>Длительность</th>
              <th>Валидация схемы</th>
              <th>Скан входа</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <span
                    className={`badge ${j.status === 'COMPLETED' ? 'badge-ok' : j.status === 'FAILED' || j.status === 'TIMEOUT' ? 'badge-bad' : 'badge-pending'}`}
                  >
                    {j.status}
                  </span>
                </td>
                <td>{j.modelVersion}</td>
                <td>{j.retryCount}</td>
                <td>{j.durationMs != null ? `${j.durationMs} мс` : '—'}</td>
                <td>
                  <span className={`badge ${j.schemaValidation === 'FAIL' ? 'badge-bad' : 'badge-ok'}`}>
                    {j.schemaValidation}
                  </span>
                </td>
                <td>
                  <span className={`badge ${j.inputScanStatus === 'BLOCKED' ? 'badge-bad' : 'badge-ok'}`}>
                    {j.inputScanStatus}
                  </span>
                </td>
                <td className="muted">{new Date(j.createdAt).toLocaleString('ru-RU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
