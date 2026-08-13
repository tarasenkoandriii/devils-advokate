'use client';

// Пункт 57 (backend) → TMA UI: очередь модерации библиотеки (§3.5
// ТЗ). Доступна только пользователям с User.isLibraryModerator — не
// self-service, не проверяется на этой странице заранее, backend сам
// вернёт ForbiddenException для обычных пользователей, показываем это
// честно, не скрываем страницу от нероли (её и так никто не найдёт
// без прямой ссылки — та же логика, что у большинства "скрытых"
// админ-страниц).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listLibraryModerationQueue, moderateLibraryEntry } from '../../../lib/features';
import { LibraryEntry } from '../../../lib/types';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function LibraryModerationPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  useBackButton(() => router.push('/'));

  function reload() {
    return listLibraryModerationQueue()
      .then(setEntries)
      .catch(() => setForbidden(true));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleModerate(entryId: string, decision: 'ACCEPT' | 'REJECT') {
    try {
      await moderateLibraryEntry(entryId, decision);
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  if (loading) return null;
  if (forbidden) {
    return (
      <main className="page">
        <h2>Очередь модерации</h2>
        <p>Эта страница доступна только модераторам библиотеки.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h2>Очередь модерации библиотеки</h2>
      {entries.length === 0 ? (
        <p className="conversations-section__hint">Заявок на модерации нет.</p>
      ) : (
        <ul className="library-moderation-list">
          {entries.map((entry) => (
            <li key={entry.id} className="library-moderation-list__item">
              <h3>{entry.title}</h3>
              <p className="conversations-section__hint">Категория: {entry.category}</p>
              <ul className="library-moderation-list__arguments">
                {(entry.arguments ?? []).map((a) => (
                  <li key={a.id}>({a.stance}) {a.text}</li>
                ))}
              </ul>
              <div className="conversations-section__add-actions">
                <button type="button" onClick={() => handleModerate(entry.id, 'ACCEPT')}>
                  Принять
                </button>
                <button type="button" onClick={() => handleModerate(entry.id, 'REJECT')}>
                  Отклонить
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
