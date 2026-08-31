'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listAdminMediaReviewQueues } from '../../lib/endpoints';
import type { AdminMediaReviewQueue } from '../../lib/types';

export default function MediaReviewAdminPage() {
  const [rows, setRows] = useState<AdminMediaReviewQueue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listAdminMediaReviewQueues().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  return (
    <div className="page">
      <p><Link href="/domains">← Сценарии</Link></p>
      <h1>Разбор медиа · очереди</h1>
      <p className="muted" style={{ marginBottom: 20 }}>«Застряли» — PROCESSING дольше суток без движения привязанной записи. До аудита 2026-08-30 элементы застревали там навсегда; сейчас это сигнал о сбое STT/анализа.</p>
      {!rows && <p className="muted">Загрузка…</p>}
      {rows && (
        <table>
          <thead><tr><th>Очередь</th><th>Владелец (tg)</th><th>Элементов</th><th>Статусы</th><th>Застряли</th></tr></thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id}>
                <td>{q.title}</td><td>{q.ownerTelegramId}</td><td>{q.totalItems}</td>
                <td>{Object.entries(q.byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}</td>
                <td>{q.stuckProcessing > 0 ? <span className="badge badge-bad">{q.stuckProcessing}</span> : <span className="badge badge-ok">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
