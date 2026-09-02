'use client';

// Пункт 57 (backend) → TMA UI: публичная страница деталей записи
// библиотеки (§3.5 ТЗ) — аргументы, голосование, "добавить свой опыт".
// Тот же принцип, что /library/page.tsx — обычный веб-роут, без
// Telegram-контекста.

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { addLibraryExperience, getLibraryEntry, voteLibraryEntry } from '../../../lib/public-api';
import { LibraryEntry } from '../../../lib/types';

export default function LibraryEntryPage() {
  const params = useParams();
  const entryId = typeof params.entryId === 'string' ? params.entryId : '';

  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [experienceText, setExperienceText] = useState('');
  const [experienceName, setExperienceName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(() => {
    return getLibraryEntry(entryId)
      .then(setEntry)
      .catch(() => setNotFound(true));
  }, [entryId]);

  useEffect(() => {
    if (!entryId) return;
    void reload().finally(() => setLoading(false));
  }, [reload, entryId]);

  async function handleVote(direction: 'up' | 'down') {
    try {
      await voteLibraryEntry(entryId, direction);
      await reload();
    } catch {
      // Молча игнорируем — голосование не критично для основного просмотра.
    }
  }

  async function handleAddExperience() {
    if (!experienceText.trim()) return;
    setSubmitting(true);
    try {
      await addLibraryExperience(entryId, experienceText.trim(), experienceName.trim() || undefined);
      await reload();
      setExperienceText('');
      setExperienceName('');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return null;
  if (notFound || !entry) {
    return (
      <main className="page">
        <h2>Запись недоступна</h2>
        <p>Эта запись библиотеки ещё не опубликована или не существует.</p>
      </main>
    );
  }

  return (
    <main className="page library-entry-page">
      <h2>{entry.title}</h2>
      <p className="conversations-section__hint">Категория: {entry.category}</p>

      <div className="conversations-section__add-actions">
        <button type="button" onClick={() => handleVote('up')}>
          👍 {entry.upvotes}
        </button>
        <button type="button" onClick={() => handleVote('down')}>
          👎 {entry.downvotes}
        </button>
      </div>

      {(entry.arguments ?? []).length > 0 && (
        <>
          <p className="steelman-case__label">Аргументы</p>
          <ul className="public-discussion-page__arguments">
            {(entry.arguments ?? []).map((a) => (
              <li key={a.id} className={`public-discussion-page__argument public-discussion-page__argument--${a.stance.toLowerCase()}`}>
                {a.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {(entry.experiences ?? []).length > 0 && (
        <>
          <p className="steelman-case__label">Чужой опыт</p>
          <ul className="public-discussion-page__comments">
            {(entry.experiences ?? []).map((exp) => (
              <li key={exp.id} className="public-discussion-page__comment">
                <span className="public-discussion-page__comment-author">{exp.authorDisplayName ?? 'Аноним'}:</span> {exp.text}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="conversations-section__add">
        <p className="steelman-case__label">Поделиться своим опытом</p>
        <input value={experienceName} onChange={(e) => setExperienceName(e.target.value)} placeholder="Ваше имя (необязательно)" />
        <input value={experienceText} onChange={(e) => setExperienceText(e.target.value)} placeholder="Ваш опыт похожего решения" />
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleAddExperience} disabled={submitting || !experienceText.trim()}>
            {submitting ? 'Отправляем…' : 'Поделиться'}
          </button>
        </div>
      </div>
    </main>
  );
}
