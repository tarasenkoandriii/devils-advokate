'use client';

// Пункт 57 (backend) → TMA UI: Library, owner-side отправка (§3.5
// ТЗ). Модерация — НЕ в TMA: с Пункта [admin-panel] она живёт в
// apps/admin за AdminSessionGuard (страница /library/moderate в TMA
// удалена аудитом — из Mini App она всегда получала бы 401).
//
// Пункт [own-submission] 2026-09-04. Этот экран УТВЕРЖДАЛ человеку:
// «ожидает модерации или уже опубликован» — два исхода из трёх, и не
// хватало ровно одного, единственного плохого: запись могли отклонить.
// Проверить было нечем — судьба отправленного не читалась нигде в
// продукте. Теперь экран спрашивает сервер и говорит, что есть на самом
// деле, включая то, чего продукт не знает: причины решения он не хранит.

import { useCallback, useEffect, useState } from 'react';
import { submitProjectToLibrary, listMyLibrarySubmissions } from '../lib/features';
import { haptic } from '../lib/telegram';
import { librarySubmissionOutcome } from '../lib/submission-status';
import type { MyLibrarySubmission } from '../lib/types';

/** Отдельно от загрузки — чтобы сверка могла НАРИСОВАТЬ этот экран с
 * данными. Мутация показала, зачем: проверка искала имя функции исхода в
 * исходнике и проходила даже тогда, когда исход был намертво выключен, —
 * имя оставалось в строке импорта. Снова «проверка написана на
 * упоминание, а не на поведение» (урок [render-guards]). */
export function LibrarySubmissionStatusView({
  submission,
  statusFailed,
}: {
  submission: MyLibrarySubmission | null;
  statusFailed: boolean;
}) {
  const outcome = submission ? librarySubmissionOutcome(submission.status, submission.moderatedAt) : null;
  return (
    <section className="library-submit-section">
      <h3>Публичная библиотека</h3>
      {outcome ? (
        <>
          <p className="library-submit-section__status">
            <strong>{outcome.label}</strong>
          </p>
          <p className="conversations-section__hint">{outcome.detail}</p>
        </>
      ) : statusFailed ? (
        // Честно: отправка была, а что с ней сейчас — мы не знаем. Это
        // не то же самое, что «ждёт модерации».
        <p className="conversations-section__hint" role="status">
          Проект отправлен в публичную библиотеку. Узнать, что с ним решили, сейчас не удалось — не отвечает
          сервер. Загляните позже.
        </p>
      ) : (
        <p className="conversations-section__hint">Проект отправлен в публичную библиотеку. Загружаем решение…</p>
      )}
    </section>
  );
}

interface LibrarySubmitSectionProps {
  projectId: string;
  hasLibraryEntry: boolean;
}

export function LibrarySubmitSection({ projectId, hasLibraryEntry }: LibrarySubmitSectionProps) {
  const [submitted, setSubmitted] = useState(hasLibraryEntry);
  const [heldBackNote, setHeldBackNote] = useState<string | null>(null);
  const [mine, setMine] = useState<MyLibrarySubmission | null>(null);
  // Отдельно от `mine`: «не знаем» и «нет решения» — разные вещи, и
  // молчать о первом значило бы снова говорить о судьбе отправки
  // увереннее, чем есть основания (урок Пункта [false-success]).
  const [statusFailed, setStatusFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    listMyLibrarySubmissions()
      .then((rows) => {
        setMine(rows.find((r) => r.sourceProjectId === projectId) ?? null);
        setStatusFailed(false);
      })
      .catch(() => setStatusFailed(true));
  }, [projectId]);

  useEffect(() => {
    if (submitted) loadStatus();
  }, [submitted, loadStatus]);

  async function handleSubmit() {
    if (!title.trim() || !category.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitProjectToLibrary(projectId, title.trim(), category.trim());
      // Пункт [never-published-was-published] 2026-09-30: часть
      // аргументов могла не уйти — те, что построены из фактов
      // «не публикуется ни при каких обстоятельствах». Сказать об этом
      // обязательно: человек отдал набор и вправе знать, что ушло не
      // всё и почему.
      setHeldBackNote(result.heldBackNote ?? null);
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
      <>
        {heldBackNote && (
          <p role="alert" className="dtp-status dtp-status--warn">
            {heldBackNote}
          </p>
        )}
        <LibrarySubmissionStatusView submission={mine} statusFailed={statusFailed} />
      </>
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
        {error && <p role="alert" className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleSubmit} disabled={submitting || !title.trim() || !category.trim()}>
            {submitting ? 'Отправляем…' : 'Отправить в библиотеку'}
          </button>
        </div>
      </div>
    </section>
  );
}
