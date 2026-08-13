'use client';

// Пункт 57 (backend) → TMA UI: публичная страница списка библиотеки
// (§3.5 ТЗ) — "даёт SEO-трафик, вирусность и социальное доказательство"
// буквально из ТЗ, поэтому НЕ использует Telegram-контекст, обычный
// веб-роут, тот же принцип, что /public/[token] (Пункт 56).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { browseLibrary } from '../../lib/public-api';
import { LibraryEntry } from '../../lib/types';

export default function LibraryPage() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    browseLibrary()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  return (
    <main className="page library-page">
      <h2>Библиотека разборов</h2>
      <p className="conversations-section__hint">
        Готовые наборы аргументов по типовым решениям, поделённые другими пользователями.
      </p>

      {entries.length === 0 ? (
        <p className="conversations-section__hint">Пока ничего не опубликовано.</p>
      ) : (
        <ul className="library-page__list">
          {entries.map((entry) => (
            <li key={entry.id} className="library-page__item">
              <Link href={`/library/${entry.id}`}>
                <strong>{entry.title}</strong>
              </Link>
              <span className="conversations-section__hint">
                {entry.category} — 👍 {entry.upvotes} 👎 {entry.downvotes}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
