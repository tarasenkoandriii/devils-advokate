'use client';

// Пункт 57 (backend) → TMA UI: публичная страница деталей записи
// библиотеки (§3.5 ТЗ) — аргументы, голосование, "добавить свой опыт".
// Тот же принцип, что /library/page.tsx — обычный веб-роут, без
// Telegram-контекста.

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { addLibraryExperience, getLibraryEntry, voteLibraryEntry } from '../../../lib/public-api';
import { LibraryEntry } from '../../../lib/types';
import { ApiRequestError } from '../../../lib/api';
import { SectionLoadError } from '../../../components/SectionLoadError';

export default function LibraryEntryPage() {
  const params = useParams();
  const entryId = typeof params.entryId === 'string' ? params.entryId : '';

  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState(false);
  const [experienceText, setExperienceText] = useState('');
  const [experienceName, setExperienceName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Пункт [false-success] 2026-09-04: у действий на этой странице не было
  // ни одного способа сообщить о сбое — голос терялся молча, а отправка
  // своего опыта не имела `catch` вовсе.
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => {
    return getLibraryEntry(entryId)
      .then(setEntry)
      // Аудит 2026-09-03: раньше ЛЮБАЯ ошибка превращалась в «запись не
      // существует». 404 — это факт о записи, 500 или обрыв связи — факт
      // о нас; смешивать их значит врать пользователю о чужой публикации.
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.httpStatus === 404) setNotFound(true);
        else setFailed(true);
      });
  }, [entryId]);

  useEffect(() => {
    if (!entryId) return;
    void reload().finally(() => setLoading(false));
  }, [reload, entryId]);

  async function handleVote(direction: 'up' | 'down') {
    setActionError(null);
    try {
      await voteLibraryEntry(entryId, direction);
      await reload();
    } catch (err) {
      // «Голосование не критично» — это про продукт, а не про человека.
      // Он нажал и видит, что число не изменилось: без объяснения нажмёт
      // ещё раз, и ещё.
      setActionError(err instanceof Error ? `Голос не засчитан: ${err.message}` : 'Голос не засчитан — попробуйте позже.');
    }
  }

  async function handleAddExperience() {
    if (!experienceText.trim()) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await addLibraryExperience(entryId, experienceText.trim(), experienceName.trim() || undefined);
      await reload();
      setExperienceText('');
      setExperienceName('');
    } catch (err) {
      // `catch` здесь не было ВОВСЕ: человек писал свой опыт, нажимал
      // «отправить» и при сбое не получал ничего — ни сообщения, ни
      // очистки поля. Текст его, и терять его молча нельзя: поле
      // намеренно НЕ очищается, чтобы написанное можно было отправить
      // ещё раз.
      setActionError(err instanceof Error ? `Не удалось отправить: ${err.message}` : 'Не удалось отправить — текст сохранён в поле, попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return null;
  if (failed) {
    return (
      <main className="page">
        <h2>Не удалось загрузить запись</h2>
        <SectionLoadError what="эту запись библиотеки" hint="её не существует" />
      </main>
    );
  }
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

      {/* [false-success] 2026-09-04: сообщение о сбое действия — рядом с
          действиями, а не где-то вверху страницы, и объявляется вслух:
          человек только что нажал, это ответ ему. */}
      {actionError && <p role="alert" className="generation-error">{actionError}</p>}

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
