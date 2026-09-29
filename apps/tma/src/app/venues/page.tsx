'use client';

// Пункт 66 (backend) → TMA UI: публичный каталог одобренных заведений
// (§3.23 ТЗ) — "публичная карточка", буквально ТЗ. Не использует
// Telegram-контекст, обычный веб-роут, тот же принцип, что
// /public/[token] (Пункт 56) и /library (Пункт 57).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { browseApprovedVenues } from '../../lib/public-api';
import { ApprovedVenue } from '../../lib/types';
import { SectionLoadError } from '../../components/SectionLoadError';

export default function VenuesPage() {
  const [venues, setVenues] = useState<ApprovedVenue[]>([]);
  const [loading, setLoading] = useState(true);
  // Аудит 2026-09-03: пустой список заведений — утверждение о каталоге,
  // а не о том, что мы до него не достучались.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    browseApprovedVenues()
      .then(setVenues)
      .catch(() => { setVenues([]); setFailed(true); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  // "Приоритетное размещение... промаркировано как реклама, не
  // смешивается с органической рекомендацией" (буквально §3.22 ТЗ) —
  // РАЗДЕЛЬНЫЕ секции с явной пометкой, не молчаливая пересортировка.
  const priorityVenues = venues.filter((v) => v.isPriorityPartner);
  const organicVenues = venues.filter((v) => !v.isPriorityPartner);

  function renderVenue(v: ApprovedVenue) {
    return (
      <li key={v.id} className="library-page__item">
        <Link href={`/venues/${v.id}`}>
          <strong>{v.name}</strong>
        </Link>
        <span className="conversations-section__hint">
          {v.address}
          {v.rating !== null && ` — ${v.rating.toFixed(1)}★`}
        </span>
      </li>
    );
  }

  return (
    <main className="page library-page">
      <h2>Заведения для встреч</h2>
      <p className="conversations-section__hint">Партнёрские заведения, подходящие для приватного разговора.</p>

      {failed ? (
        <SectionLoadError what="список заведений" hint="одобренных заведений нет" />
      ) : venues.length === 0 ? (
        <p className="conversations-section__hint">Пока ничего не одобрено.</p>
      ) : (
        <>
          {priorityVenues.length > 0 && (
            <>
              <p className="steelman-case__label venues-page__ad-label">Реклама</p>
              <ul className="library-page__list">{priorityVenues.map(renderVenue)}</ul>
            </>
          )}
          {organicVenues.length > 0 && (
            <ul className="library-page__list">{organicVenues.map(renderVenue)}</ul>
          )}
        </>
      )}
    </main>
  );
}
