'use client';

// MVP-фича 8+10: Conversation Card — отдельная страница, открывается
// одним переходом перед разговором (§3.44 ТЗ). Секция скриптов
// открытия/закрытия (фича 10) закрывает последнюю дыру — раньше здесь
// была статичная заглушка "ещё не реализовано".

import { ReactNode, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  getConversationCard,
  generateScript,
  generateAgenda,
  createProtectedNote,
  deleteProtectedNote,
} from '../../../../lib/features';
import { ConversationCard, ProtectedNoteType } from '../../../../lib/types';
import { useBackButton } from '../../../../hooks/useBackButton';
import { haptic } from '../../../../lib/telegram';

export default function ConversationCardPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [card, setCard] = useState<ConversationCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingOpening, setGeneratingOpening] = useState(false);
  const [generatingClosing, setGeneratingClosing] = useState(false);
  const [generatingAgenda, setGeneratingAgenda] = useState(false);

  // Пункт 28: форма добавления защищённой заметки — простой ручной
  // ввод (не AI), см. обоснование в protected-note.service.ts.
  const [newNoteType, setNewNoteType] = useState<ProtectedNoteType>('ACE_IN_THE_HOLE');
  const [newNoteContent, setNewNoteContent] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useBackButton(() => router.push(`/projects/${params.id}`));

  function loadCard(id: string) {
    return getConversationCard(id)
      .then(setCard)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить карточку'));
  }

  useEffect(() => {
    if (!params.id) return;
    void loadCard(params.id).finally(() => setLoading(false));

  }, [params.id]);

  async function handleGenerateScript(type: 'OPENING' | 'CLOSING') {
    if (!params.id) return;
    const setGenerating = type === 'OPENING' ? setGeneratingOpening : setGeneratingClosing;
    setGenerating(true);
    try {
      await generateScript(params.id, type);
      await loadCard(params.id);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сгенерировать скрипт');
    } finally {
      setGenerating(false);
    }
  }

  async function handleGenerateAgenda() {
    if (!params.id) return;
    setGeneratingAgenda(true);
    try {
      await generateAgenda(params.id);
      await loadCard(params.id);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сформировать повестку');
    } finally {
      setGeneratingAgenda(false);
    }
  }

  async function handleAddNote() {
    if (!params.id || !newNoteContent.trim()) return;
    setSavingNote(true);
    try {
      await createProtectedNote(params.id, { type: newNoteType, content: newNoteContent.trim() });
      setNewNoteContent('');
      await loadCard(params.id);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить заметку');
    } finally {
      setSavingNote(false);
    }
  }

  async function handleDeleteNote(noteId: string) {
    if (!params.id) return;
    try {
      await deleteProtectedNote(noteId);
      await loadCard(params.id);
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  if (loading) return <main className="page">Загрузка…</main>;
  if (error) return <main className="page"><p className="generation-error">{error}</p></main>;
  if (!card) return null;

  return (
    <main className="page">
      <h1>{card.project.question}</h1>
      {card.project.goal && <p className="project-detail__goal">Цель: {card.project.goal}</p>}

      <CardSection title="Цель разговора">
        {card.objective ? (
          <>
            {card.objective.desiredOutcome && <p>Желаемый исход: {card.objective.desiredOutcome}</p>}
            {card.objective.minimumAcceptableOutcome && (
              <p>Минимум приемлемо: {card.objective.minimumAcceptableOutcome}</p>
            )}
            {card.objective.unacceptableOutcome && (
              <p>Красная черта: {card.objective.unacceptableOutcome}</p>
            )}
          </>
        ) : (
          <EmptyNote>Не заполнено — вернитесь на страницу проекта, чтобы добавить</EmptyNote>
        )}
      </CardSection>

      <CardSection title="Ключевые аргументы">
        {card.topArguments.length > 0 ? (
          <ul className="card-argument-list">
            {card.topArguments.map((a) => (
              <li key={a.id}>
                {a.stance === 'PRO' ? '+ ' : '− '}
                {a.text}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Аргументы ещё не сгенерированы</EmptyNote>
        )}
      </CardSection>

      <CardSection title="BATNA / WATNA / точка выхода">
        {card.boundaries ? (
          <>
            {card.boundaries.batna && <p>BATNA: {card.boundaries.batna}</p>}
            {card.boundaries.watna && <p>WATNA: {card.boundaries.watna}</p>}
            {card.boundaries.walkAwayPoint && <p>Точка выхода: {card.boundaries.walkAwayPoint}</p>}
          </>
        ) : (
          <EmptyNote>Не заполнено — вернитесь на страницу проекта, чтобы добавить</EmptyNote>
        )}
      </CardSection>

      <CardSection title="Не стоит упоминать">
        {card.doNotSay.length > 0 ? (
          <ul className="card-argument-list">
            {card.doNotSay.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Ничего не отмечено</EmptyNote>
        )}
      </CardSection>

      <CardSection title="Предупреждения из прошлых разговоров">
        {card.selfRiskWarnings.length > 0 ? (
          <ul className="self-risk-warnings">
            {card.selfRiskWarnings.map((w) => (
              <li key={w.id} className="self-risk-warnings__item">
                <span className="self-risk-warnings__category">
                  {w.riskCategory === 'ESCALATION' ? '⚠️ Может обострить конфликт' : '⚠️ Может быть использовано против вас'}
                </span>
                {w.why && <span className="self-risk-warnings__why">{w.why}</span>}
                {w.saferAlternative && (
                  <span className="self-risk-warnings__alternative">Лучше сказать: «{w.saferAlternative}»</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Ничего не найдено — или разговоры ещё не проверены (см. страницу разговора)</EmptyNote>
        )}
      </CardSection>

      <CardSection title="Устаревшие факты">
        {card.staleFacts.length > 0 ? (
          <ul className="stale-facts">
            {card.staleFacts.map((f) => (
              <li key={f.id} className="stale-facts__item">
                <span className="stale-facts__age">
                  {f.personDisplayName ?? 'Фигурант'} — {Math.floor(f.ageInDays / 30)} мес. назад
                </span>
                <span>{f.content}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Все ключевые факты проверялись за последний год</EmptyNote>
        )}
      </CardSection>

      <CardSection title="Повестка следующего разговора">
        {card.agenda.length > 0 ? (
          <ul className="card-argument-list">
            {card.agenda.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Ещё не сформирована</EmptyNote>
        )}
        <button
          type="button"
          className="script-generate-button"
          onClick={handleGenerateAgenda}
          disabled={generatingAgenda}
        >
          {generatingAgenda ? 'Формируем…' : card.agenda.length > 0 ? 'Сформировать заново' : 'Сформировать повестку'}
        </button>
      </CardSection>

      <CardSection title="Туз в рукаве / План Б">
        {card.protectedNotes.length > 0 ? (
          <ul className="protected-notes">
            {card.protectedNotes.map((note) => (
              <li key={note.id} className="protected-notes__item">
                <span className="protected-notes__type">
                  {note.type === 'ACE_IN_THE_HOLE' ? '🃏 Туз в рукаве' : `📋 План Б${note.planOrder && note.planOrder > 1 ? '/В' : ''}`}
                </span>
                <span>{note.content}</span>
                {note.triggerCondition && (
                  <span className="protected-notes__trigger">Если: {note.triggerCondition}</span>
                )}
                <button type="button" onClick={() => handleDeleteNote(note.id)}>
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>Ничего не сохранено</EmptyNote>
        )}

        <div className="conversations-section__add">
          <label>
            Тип
            <select value={newNoteType} onChange={(e) => setNewNoteType(e.target.value as ProtectedNoteType)}>
              <option value="ACE_IN_THE_HOLE">Туз в рукаве</option>
              <option value="FALLBACK_PLAN">План Б / В</option>
            </select>
          </label>
          <label>
            Содержание
            <input value={newNoteContent} onChange={(e) => setNewNoteContent(e.target.value)} />
          </label>
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleAddNote} disabled={savingNote || !newNoteContent.trim()}>
              {savingNote ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </CardSection>

      <CardSection title="Начало разговора">
        {card.openingScript ? (
          <p className="script-text">{card.openingScript}</p>
        ) : (
          <EmptyNote>Ещё не сгенерировано</EmptyNote>
        )}
        <button
          type="button"
          className="script-generate-button"
          onClick={() => handleGenerateScript('OPENING')}
          disabled={generatingOpening}
        >
          {generatingOpening ? 'Генерируем…' : card.openingScript ? 'Сгенерировать заново' : 'Сгенерировать'}
        </button>
      </CardSection>

      <CardSection title="Завершение разговора">
        {card.closingScript ? (
          <p className="script-text">{card.closingScript}</p>
        ) : (
          <EmptyNote>Ещё не сгенерировано</EmptyNote>
        )}
        <button
          type="button"
          className="script-generate-button"
          onClick={() => handleGenerateScript('CLOSING')}
          disabled={generatingClosing}
        >
          {generatingClosing ? 'Генерируем…' : card.closingScript ? 'Сгенерировать заново' : 'Сгенерировать'}
        </button>
      </CardSection>
    </main>
  );
}

function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="card-section__empty">{children}</p>;
}
