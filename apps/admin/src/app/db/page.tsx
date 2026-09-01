'use client';

// Пункт [db-state] 2026-09-01 — вкладка «БД» (по прямому запросу:
// «уточнить расписание кронов + лог их выполнения, чтобы не пробивать
// руками в базе каждый раз»). Read-only зеркало того, что во время
// живых прогонов смотрели через SQL Editor Supabase: cron.job,
// cron.job_run_details, net._http_response, ai_jobs.
//
// Каждая секция может независимо оказаться ошибкой (локальная БД без
// pg_cron/pg_net) — рендерится текст ошибки Postgres, он сам по себе
// диагноз. Автообновление каждые 30 с, пока вкладка открыта — тот же
// приём, что у очереди в Sandbox (15 с там оправданы прогрессом
// разбора; здесь состояние меняется раз в минуту-три по кронам).

import { useCallback, useEffect, useState } from 'react';
import { getAdminDbState } from '../../lib/endpoints';
import type { AdminDbState, DbStateSection } from '../../lib/types';

const REFRESH_MS = 30_000;

// Ожидаемые расписания — из pg_cron_ai_jobs.sql (poll прорежен до
// «*/3» Пунктом [poll-thinning]); расхождение подсвечивается: живой
// инстанс настраивается вручную и легко отстаёт от файла в репозитории.
const EXPECTED_SCHEDULES: Record<string, string> = {
  'ai-jobs-submit': '* * * * *',
  'ai-jobs-poll': '*/3 * * * *',
  'ai-jobs-reap': '* * * * *',
};

function isError<T>(s: DbStateSection<T>): s is { error: string } {
  return typeof s === 'object' && s !== null && 'error' in (s as object) && !Array.isArray(s);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU')}`;
}

function durationSec(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms >= 0 ? `${(ms / 1000).toFixed(1)} с` : '—';
}

function SectionError({ section }: { section: { error: string } }) {
  return (
    <p style={{ color: 'var(--signal-critical)', fontSize: 13 }}>
      Секция недоступна: {section.error}
    </p>
  );
}

export default function DbStatePage() {
  const [state, setState] = useState<AdminDbState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getAdminDbState()
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="page">
      <h1>БД-состояние</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Read-only зеркало служебных таблиц: расписание pg_cron, лог запусков, фактические ответы
        API на вызовы кронов (pg_net) и сводка AI-джоб. Управление кронами — по-прежнему через
        SQL Editor (pg_cron_ai_jobs.sql). Автообновление каждые 30 с.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? 'Обновляем…' : 'Обновить сейчас'}
        </button>
        {state && <span className="muted" style={{ fontSize: 12 }}>Снимок: {fmtTime(state.generatedAt)}</span>}
      </div>
      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && (
        <>
          {/* ── 1. Расписание кронов ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Крон-джобы (cron.job)</h2>
            {isError(state.cronJobs) ? (
              <SectionError section={state.cronJobs} />
            ) : state.cronJobs.length === 0 ? (
              <p className="muted">Джоб нет — pg_cron_ai_jobs.sql ещё не применялся на этом инстансе.</p>
            ) : (
              <table>
                <thead><tr><th>Имя</th><th>Расписание</th><th>Активна</th><th>Соответствие файлу</th></tr></thead>
                <tbody>
                  {state.cronJobs.map((j) => {
                    const expected = EXPECTED_SCHEDULES[j.jobname];
                    const mismatch = expected !== undefined && expected !== j.schedule;
                    return (
                      <tr key={j.jobname}>
                        <td>{j.jobname}</td>
                        <td><code>{j.schedule}</code></td>
                        <td>{j.active ? <span className="badge badge-ok">да</span> : <span className="badge badge-bad">выключена</span>}</td>
                        <td>
                          {expected === undefined ? (
                            <span className="muted">не наша (другой файл)</span>
                          ) : mismatch ? (
                            <span className="badge badge-bad" title={`в pg_cron_ai_jobs.sql: ${expected}`}>ожидалось {expected}</span>
                          ) : (
                            <span className="badge badge-ok">совпадает</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* ── 2. Лог запусков ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Лог запусков (cron.job_run_details, последние 60)</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              «succeeded» здесь означает лишь «HTTP-вызов поставлен в очередь pg_net», не «API ответил
              успешно» — фактические ответы в следующей секции.
            </p>
            {isError(state.cronRuns) ? (
              <SectionError section={state.cronRuns} />
            ) : state.cronRuns.length === 0 ? (
              <p className="muted">Запусков ещё не было.</p>
            ) : (
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>Когда</th><th>Джоба</th><th>Статус</th><th>Длит.</th><th>Сообщение</th></tr></thead>
                  <tbody>
                    {state.cronRuns.map((r, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.startTime)}</td>
                        <td>{r.jobname}</td>
                        <td>
                          {r.status === 'succeeded'
                            ? <span className="badge badge-ok">succeeded</span>
                            : <span className="badge badge-bad">{r.status}</span>}
                        </td>
                        <td>{durationSec(r.startTime, r.endTime)}</td>
                        <td className="muted" style={{ fontSize: 12, maxWidth: 380, overflowWrap: 'anywhere' }}>{r.returnMessage ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── 3. Ответы API на вызовы кронов ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Ответы API (net._http_response, последние 60)</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Фактические HTTP-ответы наших internal-эндпоинтов: 201 с телом {'{'}«completed», «failed»,
              «waiting»{'}'} — норма; 401 — рассинхрон x-dispatch-secret; 5xx — падение функции. pg_net
              хранит ответы около 6 часов, пустая таблица на тихом инстансе — норма. URL pg_net не
              хранит — эндпоинт опознаётся по телу ответа.
            </p>
            {isError(state.httpResponses) ? (
              <SectionError section={state.httpResponses} />
            ) : state.httpResponses.length === 0 ? (
              <p className="muted">Ответов за последние ~6 часов нет.</p>
            ) : (
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>Когда</th><th>HTTP</th><th>Тело / ошибка</th></tr></thead>
                  <tbody>
                    {state.httpResponses.map((r, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.created)}</td>
                        <td>
                          {r.timedOut ? (
                            <span className="badge badge-bad">timeout</span>
                          ) : r.statusCode !== null && r.statusCode < 300 ? (
                            <span className="badge badge-ok">{r.statusCode}</span>
                          ) : (
                            <span className="badge badge-bad">{r.statusCode ?? '—'}</span>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 12, maxWidth: 480, overflowWrap: 'anywhere' }}>
                          {r.errorMsg ? `${r.errorMsg} ` : ''}{r.content || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── 4. Сводка AI-джоб ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>AI-джобы (ai_jobs)</h2>
            {isError(state.aiJobs) ? (
              <SectionError section={state.aiJobs} />
            ) : (
              <>
                <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {Object.entries(state.aiJobs.byStatus).length === 0 && <span className="muted">Джоб пока нет.</span>}
                  {Object.entries(state.aiJobs.byStatus).map(([status, count]) => (
                    <span
                      key={status}
                      className={`badge ${status === 'FAILED' ? 'badge-bad' : status === 'COMPLETED' ? 'badge-ok' : 'badge-pending'}`}
                    >
                      {status}: {count}
                    </span>
                  ))}
                </p>
                {state.aiJobs.recent.length > 0 && (
                  <table>
                    <thead><tr><th>Создана</th><th>Задача</th><th>Статус</th><th>Ретраи</th><th>У провайдера</th><th>Lease до</th><th>Заметка воркера</th></tr></thead>
                    <tbody>
                      {state.aiJobs.recent.map((j) => (
                        <tr key={j.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(j.createdAt)}</td>
                          <td>{j.taskType ?? '—'}</td>
                          <td>
                            {j.status === 'COMPLETED'
                              ? <span className="badge badge-ok">COMPLETED</span>
                              : j.status === 'FAILED'
                                ? <span className="badge badge-bad">FAILED</span>
                                : <span className="badge badge-pending">{j.status}</span>}
                          </td>
                          <td>{j.retryCount}</td>
                          <td>{j.submitted ? 'да' : 'нет'}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(j.leaseExpiresAt)}</td>
                          <td className="muted" style={{ fontSize: 12, maxWidth: 360, overflowWrap: 'anywhere' }}>{j.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
