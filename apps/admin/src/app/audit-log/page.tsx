'use client';

// Пункт [dead-code-audit] 2026-09-03 — вкладка «Аудит».
//
// Найдено сверкой маршрутов с их вызовами: `GET /admin/audit-log` был
// реализован и закрыт правом оператора, но ни одно приложение его не
// звало. То есть журнал «оператор решил что-то за пользователя» писался
// исправно и не читался никем — а смысл такого журнала ровно в том,
// чтобы его читали. Тот же класс пробела, что «код без экрана» в
// прошлых аудитах, только на самой подотчётности.
//
// Экран сознательно read-only: запись аудита нельзя ни отредактировать,
// ни удалить из интерфейса — иначе журнал перестаёт быть журналом.

import { useCallback, useEffect, useState } from 'react';
import { getAuditLog } from '../../lib/endpoints';
import type { AuditLogRow } from '../../lib/types';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU')}`;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Поля ввода и применённый фильтр разделены — тот же приём, что на
  // вкладке телеметрии: иначе каждый символ бил бы в API.
  const [resource, setResource] = useState('');
  const [actorId, setActorId] = useState('');
  const [applied, setApplied] = useState<{ resource?: string; actorId?: string }>({});
  // Сверка чтений без потолка 2026-09-04: потолок в 200 записей стоял и
  // молчал. По журналу разбирают жалобу — список, выглядящий полным,
  // здесь дороже, чем где-либо ещё.
  const [truncated, setTruncated] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const page = await getAuditLog(applied);
      setRows(page.items);
      setTruncated(page.hasMore ? page.limit : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить журнал');
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Журнал действий</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Решения, принятые оператором за пользователя, и отправки, у которых остались открытые
        пункты чеклиста. Только чтение: записи журнала не редактируются и не удаляются из
        интерфейса. Отдаются последние 200 записей — сузьте фильтром, если нужно глубже.
      </p>

      {truncated !== null && (
        <p className="error" role="note" style={{ marginBottom: 20 }}>
          Потолок сработал: показаны {truncated} самых новых записей, за ними есть ещё. Этот список
          неполный — сузьте фильтром, прежде чем делать вывод «такого действия не было».
        </p>
      )}

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12 }} className="muted">
          Объект (resource)
          <input
            style={{ marginLeft: 6 }}
            value={resource}
            placeholder="User, PromptVersion, ShipmentChecklist…"
            onChange={(e) => setResource(e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }} className="muted">
          Кто (actorId)
          <input style={{ marginLeft: 6 }} value={actorId} onChange={(e) => setActorId(e.target.value)} />
        </label>
        <button type="button" onClick={() => setApplied({ resource: resource.trim() || undefined, actorId: actorId.trim() || undefined })}>
          Показать
        </button>
      </div>

      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      {!error && rows === null && <p className="muted">Загрузка…</p>}
      {!error && rows !== null && rows.length === 0 && (
        <p className="muted">
          Записей нет. Это не обязательно значит «ничего не происходило» — под текущий фильтр
          ничего не попало.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="card">
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Когда</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Действие</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Объект</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Кто</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Было → стало</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border, #333)' }}>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTime(r.createdAt)}</td>
                  <td style={{ padding: '6px 8px' }}>{r.action}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {r.resource}
                    <span className="muted"> {r.resourceId}</span>
                  </td>
                  {/* Системное действие (крон) — честно «система», не пустая ячейка
                      и не подставленный оператор. */}
                  <td style={{ padding: '6px 8px' }}>{r.actorId ?? <span className="muted">система</span>}</td>
                  <td style={{ padding: '6px 8px', wordBreak: 'break-word' }}>
                    <span className="muted">{preview(r.before)}</span>
                    {' → '}
                    {preview(r.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
