'use client';

// Пункт 28 (backend) → TMA UI: Protected Notes / "Туз в рукаве и План
// Б" (раздел 2 ТЗ, MVP v2 пункт 16). Найдено полным аудитом кода/
// тестов/документации/фронтенда — backend полностью рабочий и
// протестированный с Пункта 28, ноль потребителей в TMA.
//
// ЧЕСТНО НЕ РЕАЛИЗОВАНО НА BACKEND, ПОЭТОМУ И ЗДЕСЬ ТОЖЕ НЕТ —
// "система напоминает о нём, когда разговор заходит в тупик"
// (buкально ТЗ) — детектировать "тупик" нечем без live-мониторинга,
// см. обоснование в protected-note.service.ts. Заметки только
// сохраняются и показываются здесь статично — не всплывают
// проактивно в момент разговора.
//
// ДВА ТИПА ЗАМЕТКИ, РАЗНАЯ ФОРМА — ACE_IN_THE_HOLE (только текст, без
// порядка/условия — "туз" не выкладывается по очереди) и FALLBACK_PLAN
// (текст + planOrder "План Б, В..." + triggerCondition "когда это
// предлагать").

import { useEffect, useState } from 'react';
import { createProtectedNote, listProtectedNotes, updateProtectedNote, deleteProtectedNote } from '../lib/features';
import { ProtectedNote, ProtectedNoteType } from '../lib/types';
import { haptic } from '../lib/telegram';

interface ProtectedNotesSectionProps {
  projectId: string;
}

const TYPE_LABELS: Record<ProtectedNoteType, string> = {
  ACE_IN_THE_HOLE: '🃏 Туз в рукаве',
  FALLBACK_PLAN: '🔁 План Б',
};

export function ProtectedNotesSection({ projectId }: ProtectedNotesSectionProps) {
  const [notes, setNotes] = useState<ProtectedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newType, setNewType] = useState<ProtectedNoteType>('ACE_IN_THE_HOLE');
  const [newContent, setNewContent] = useState('');
  const [newTriggerCondition, setNewTriggerCondition] = useState('');
  const [newPlanOrder, setNewPlanOrder] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  function reload() {
    return listProtectedNotes(projectId)
      .then(setNotes)
      .catch(() => setNotes([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleAdd() {
    const content = newContent.trim();
    if (!content) return;
    setAdding(true);
    setError(null);
    try {
      await createProtectedNote(projectId, {
        type: newType,
        content,
        triggerCondition: newType === 'FALLBACK_PLAN' && newTriggerCondition.trim() ? newTriggerCondition.trim() : undefined,
        planOrder: newType === 'FALLBACK_PLAN' && newPlanOrder.trim() ? parseInt(newPlanOrder, 10) : undefined,
      });
      setNewContent('');
      setNewTriggerCondition('');
      setNewPlanOrder('');
      setShowAddForm(false);
      await reload();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить заметку');
    } finally {
      setAdding(false);
    }
  }

  function handleStartEdit(note: ProtectedNote) {
    setEditingId(note.id);
    setEditContent(note.content);
  }

  async function handleSaveEdit(noteId: string) {
    const content = editContent.trim();
    if (!content) return;
    try {
      await updateProtectedNote(noteId, { content });
      setEditingId(null);
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  async function handleDelete(noteId: string) {
    try {
      await deleteProtectedNote(noteId);
      await reload();
      haptic('light');
    } catch {
      haptic('error');
    }
  }

  if (loading) return null;

  const aceNotes = notes.filter((n) => n.type === 'ACE_IN_THE_HOLE');
  const fallbackNotes = notes.filter((n) => n.type === 'FALLBACK_PLAN');

  return (
    <section className="protected-notes-section">
      <h3>Туз в рукаве и План Б</h3>
      <p className="conversations-section__hint">
        Отдельные защищённые заметки — сильные аргументы или запасные варианты, которые вы бережёте до нужного
        момента. Показываются здесь, в карточке разговора — проактивных напоминаний «в момент тупика» пока нет,
        для этого нужен live-мониторинг разговора, которого в проекте не построено.
      </p>

      {aceNotes.length > 0 && (
        <div className="protected-notes-section__group">
          <p className="steelman-case__label">🃏 Тузы в рукаве</p>
          <ul>
            {aceNotes.map((n) => (
              <li key={n.id} className="protected-notes-section__note">
                {editingId === n.id ? (
                  <>
                    <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} />
                    <div className="conversations-section__add-actions">
                      <button type="button" onClick={() => handleSaveEdit(n.id)}>
                        Сохранить
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Отмена
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span onClick={() => handleStartEdit(n)}>{n.content}</span>
                    <button type="button" onClick={() => handleDelete(n.id)}>
                      Удалить
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fallbackNotes.length > 0 && (
        <div className="protected-notes-section__group">
          <p className="steelman-case__label">🔁 Планы Б</p>
          <ul>
            {fallbackNotes.map((n) => (
              <li key={n.id} className="protected-notes-section__note">
                {editingId === n.id ? (
                  <>
                    <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} />
                    <div className="conversations-section__add-actions">
                      <button type="button" onClick={() => handleSaveEdit(n.id)}>
                        Сохранить
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Отмена
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {n.planOrder !== null && <strong>№{n.planOrder} </strong>}
                    <span onClick={() => handleStartEdit(n)}>{n.content}</span>
                    {n.triggerCondition && (
                      <p className="conversations-section__hint">Когда предлагать: {n.triggerCondition}</p>
                    )}
                    <button type="button" onClick={() => handleDelete(n.id)}>
                      Удалить
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="generation-error">{error}</p>}

      {showAddForm ? (
        <div className="conversations-section__add">
          <label>
            Тип
            <select value={newType} onChange={(e) => setNewType(e.target.value as ProtectedNoteType)}>
              {(Object.keys(TYPE_LABELS) as ProtectedNoteType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Текст
            <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={3} />
          </label>
          {newType === 'FALLBACK_PLAN' && (
            <>
              <label>
                Порядковый номер (например, 1 для «Плана Б», 2 для «Плана В»)
                <input
                  type="number"
                  value={newPlanOrder}
                  onChange={(e) => setNewPlanOrder(e.target.value)}
                  placeholder="1"
                />
              </label>
              <label>
                Когда предлагать (необязательно)
                <input
                  value={newTriggerCondition}
                  onChange={(e) => setNewTriggerCondition(e.target.value)}
                  placeholder="Например: если собеседник отклонит первое предложение"
                />
              </label>
            </>
          )}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleAdd} disabled={adding || !newContent.trim()}>
              {adding ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowAddForm(false)} disabled={adding}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowAddForm(true)}>
          + Добавить заметку
        </button>
      )}
    </section>
  );
}
