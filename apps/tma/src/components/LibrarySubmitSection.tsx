'use client';

// Пункт 57 (backend) → TMA UI: Library, owner-side отправка (§3.5
// ТЗ). Модерация — отдельная страница /library/moderate, доступна
// только пользователям с User.isLibraryModerator (не self-service,
// не в этой секции — обычный пользователь её не увидит вообще, кроме
// как по прямой ссылке, и backend всё равно отклонит запрос без роли).

import { useState } from 'react';
import { submitProjectToLibrary } from '../lib/features';
import { haptic } from '../lib/telegram';

interface LibrarySubmitSectionProps {
  projectId: string;
  hasLibraryEntry: boolean;
}

export function LibrarySubmitSection({ projectId, hasLibraryEntry }: LibrarySubmitSectionProps) {
  const [submitted, setSubmitted] = useState(hasLibraryEntry);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!title.trim() || !category.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitProjectToLibrary(projectId, title.trim(), category.trim());
      setSubmitted(true);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось отправить в библиотеку');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <section className="library-submit-section">
        <h3>Публичная библиотека</h3>
        <p className="conversations-section__hint">
          Этот проект уже отправлен в публичную библиотеку — ожидает модерации или уже опубликован.
        </p>
      </section>
    );
  }

  return (
    <section className="library-submit-section">
      <h3>Публичная библиотека</h3>
      <p className="conversations-section__hint">
        Поделитесь своим набором аргументов с другими — после модерации он появится в публичной библиотеке типовых
        решений (анонимно, без ваших фактов и документов, только общие аргументы за/против).
      </p>

      <div className="conversations-section__add">
        <label>
          Заголовок
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Стоит ли переезжать в другой город" />
        </label>
        <label>
          Категория
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Например: Переезд" />
        </label>
        {error && <p className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleSubmit} disabled={submitting || !title.trim() || !category.trim()}>
            {submitting ? 'Отправляем…' : 'Отправить в библиотеку'}
          </button>
        </div>
      </div>
    </section>
  );
}
