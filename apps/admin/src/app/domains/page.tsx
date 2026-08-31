'use client';

// Фаза F — воронка по доменным сценариям: сколько проектов, сколько дошло
// до конфига. Именно это показывает «мёртвый» домен (аудит 2026-08-30 §7.1).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getDomainsSummary } from '../../lib/endpoints';
import type { DomainSummaryRow } from '../../lib/types';

const TITLES: Record<string, string> = { dtp: 'ДТП', 'family-law': 'Семейное право', health: 'Здоровье', 'interview-pool': 'Подбор персонала', investment: 'Инвестиции', 'major-purchase': 'Крупная покупка' };

export default function DomainsPage() {
  const [rows, setRows] = useState<DomainSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getDomainsSummary().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  return (
    <div className="page">
      <h1>Доменные сценарии</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Проекты по сценариям и доля дошедших до конфига (онбординг → extract → config). Read-only. См. также <Link href="/intake">intake-квиз</Link> и <Link href="/media-review">разбор медиа</Link>.</p>
      {!rows && <p className="muted">Загрузка…</p>}
      {rows && (
        <table>
          <thead><tr><th>Сценарий</th><th>Всего</th><th>7 дн</th><th>30 дн</th><th>С конфигом</th><th>Доля</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.domain}>
                <td><Link href={`/domains/${r.domain}`}>{TITLES[r.domain] ?? r.domain}</Link></td>
                <td>{r.total}</td><td>{r.last7}</td><td>{r.last30}</td><td>{r.withConfig}</td>
                <td>{r.configRate === null ? '—' : <span className={r.configRate < 0.3 ? 'badge badge-bad' : 'badge badge-ok'}>{Math.round(r.configRate * 100)}%</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
