'use client';

// Полный аудит 2026-08-30 — юридические ссылки по домену. Backend
// (LegalDisclaimerService, seed по юрисдикции) существовал с Пункта
// [legal-disclaimer], манифест доменов оставил под него слот
// disclaimerKey, но ни одна страница его не вызывала.
import { useEffect, useState } from 'react';
import { getLegalDisclaimer } from '../../lib/features';
import type { LegalDisclaimerResponse } from '../../lib/types';

const MODE_BY_DOMAIN: Record<string, string> = {
  dtp: 'DTP', 'family-law': 'FAMILY_LAW', health: 'HEALTH',
  'interview-pool': 'INTERVIEW_POOL', investment: 'INVESTMENT', 'major-purchase': 'MAJOR_PURCHASE',
};

export function DomainLegalDisclaimer({ domainId }: { domainId: string }) {
  const [data, setData] = useState<LegalDisclaimerResponse | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const mode = MODE_BY_DOMAIN[domainId];
    if (!mode) { setData(null); return; }
    getLegalDisclaimer(mode).then(setData).catch(() => setData(null));
  }, [domainId]);
  if (!data) return null;
  return (
    <details className="dtp-card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="dtp-card__head" style={{ cursor: 'pointer' }}>
        ⚖️ Что говорит закон ({data.bucket}) — {data.references.length} ссылк{data.references.length === 1 ? 'а' : data.references.length < 5 ? 'и' : ''}
      </summary>
      <div className="dtp-card__body">
        <p className="dtp-hint">Это не юридическая консультация — только ориентиры, какие нормы обычно применимы. Дата последней проверки указана у каждой: если она старше года, перепроверьте актуальность.</p>
        {data.references.map((r, i) => (
          <div key={i} style={{ width: '100%' }}>
            <strong>{r.actName}</strong> <span className="dtp-muted">· {r.citation}</span>
            <p style={{ margin: '4px 0' }}>{r.summary}</p>
            <span className="dtp-muted">проверено {new Date(r.lastVerifiedAt).toLocaleDateString('ru-RU')}{r.sourceUrl && <> · <a href={r.sourceUrl} target="_blank" rel="noreferrer">источник</a></>}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
