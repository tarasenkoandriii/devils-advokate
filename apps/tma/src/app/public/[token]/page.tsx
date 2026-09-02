'use client';

// Пункт 56 (backend) → TMA UI: Public Discussion, публичная страница
// (§4.5 ТЗ). НЕ использует Telegram-аутентификацию — открывается
// обычным браузером кем угодно, у кого есть ссылка (репост в группу,
// домовой чат, рабочий чат). Использует lib/public-api.ts, не
// lib/features.ts — тот файл требует Telegram WebApp-контекста и упал
// бы здесь.
//
// "Участники видят только Argument, доступа к PersonFact нет" (§4.3
// ТЗ) — эта страница физически не может показать факты/документы,
// backend их и не возвращает через этот эндпоинт.

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  addPublicComment,
  getPublicDiscussion,
  joinPublicDiscussion,
  submitPublicArgument,
  votePublicSubmission,
} from '../../../lib/public-api';
import { PublicDiscussionView } from '../../../lib/types';

export default function PublicDiscussionPage() {
  const params = useParams();
  const token = typeof params.token === 'string' ? params.token : '';

  const [view, setView] = useState<PublicDiscussionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [joined, setJoined] = useState(false);

  const [newArgText, setNewArgText] = useState('');
  const [newArgStance, setNewArgStance] = useState<'PRO' | 'CON'>('PRO');
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    return getPublicDiscussion(token)
      .then(setView)
      .catch(() => setNotFound(true));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void reload().finally(() => setLoading(false));
  }, [reload, token]);

  async function handleJoin(anonymous: boolean) {
    try {
      const participant = await joinPublicDiscussion(token, anonymous ? undefined : displayName.trim());
      setParticipantId(participant.id);
      setJoined(true);
    } catch {
      // Присоединение необязательно для просмотра — молча остаёмся анонимными без participantId.
      setJoined(true);
    }
  }

  async function handleSubmitArgument() {
    if (!newArgText.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitPublicArgument(token, newArgText.trim(), newArgStance, participantId ?? undefined);
      await reload();
      setNewArgText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить аргумент');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVote(submissionId: string, direction: 'up' | 'down') {
    try {
      await votePublicSubmission(token, submissionId, direction);
      await reload();
    } catch {
      // Молча игнорируем — голосование не критично для основного просмотра.
    }
  }

  async function handleComment() {
    if (!commentText.trim()) return;
    try {
      await addPublicComment(token, commentText.trim(), participantId ?? undefined);
      await reload();
      setCommentText('');
    } catch {
      setError('Не удалось отправить комментарий');
    }
  }

  if (loading) return null;
  if (notFound || !view) {
    return (
      <main className="page">
        <h2>Обсуждение недоступно</h2>
        <p>Ссылка недействительна или обсуждение больше не публично доступно.</p>
      </main>
    );
  }

  return (
    <main className="page public-discussion-page">
      <h2>{view.question}</h2>
      {view.goal && <p className="conversations-section__hint">Цель: {view.goal}</p>}
      <p className="conversations-section__hint">
        Вы видите только аргументы за/против — исходные факты и документы автора остаются закрытыми.
      </p>

      {view.protocol && (
        <div className="public-discussion-page__protocol">
          <p className="steelman-case__label">Протокол по итогам</p>
          <p>{view.protocol.summaryText}</p>
        </div>
      )}

      {view.closingMessage && (
        <div className="public-discussion-page__closing">
          <p className="steelman-case__label">Итог</p>
          <p>{view.closingMessage.summaryText}</p>
          {view.closingMessage.quoteText && (
            <p className="closing-message-section__quote">
              «{view.closingMessage.quoteText}» — {view.closingMessage.quoteSourceReference}
            </p>
          )}
        </div>
      )}

      {!joined && (
        <div className="public-discussion-page__join">
          <label>
            Ваше имя (необязательно)
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Оставить анонимно" />
          </label>
          <div className="conversations-section__add-actions">
            <button type="button" onClick={() => handleJoin(false)}>
              Присоединиться
            </button>
            <button type="button" onClick={() => handleJoin(true)}>
              Участвовать анонимно
            </button>
          </div>
        </div>
      )}

      {view.arguments.length > 0 && (
        <>
          <p className="steelman-case__label">Аргументы</p>
          <ul className="public-discussion-page__arguments">
            {view.arguments.map((a) => (
              <li key={a.id} className={`public-discussion-page__argument public-discussion-page__argument--${a.stance.toLowerCase()}`}>
                {a.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {view.submissions.length > 0 && (
        <>
          <p className="steelman-case__label">Заявки участников</p>
          <ul className="public-discussion-page__submissions">
            {view.submissions.map((s) => (
              <li key={s.id} className="public-discussion-page__submission">
                <span>({s.stance}) {s.text}</span>
                <span className="conversations-section__hint">
                  {s.status === 'PENDING' && 'на рассмотрении у автора'}
                  {s.status === 'ACCEPTED' && '✓ принято автором'}
                  {s.status === 'REJECTED' && 'отклонено автором'}
                </span>
                <div className="conversations-section__add-actions">
                  <button type="button" onClick={() => handleVote(s.id, 'up')}>
                    👍 {s.upvotes}
                  </button>
                  <button type="button" onClick={() => handleVote(s.id, 'down')}>
                    👎 {s.downvotes}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {joined && (
        <div className="conversations-section__add">
          <p className="steelman-case__label">Добавить свой аргумент</p>
          <select value={newArgStance} onChange={(e) => setNewArgStance(e.target.value as 'PRO' | 'CON')}>
            <option value="PRO">За</option>
            <option value="CON">Против</option>
          </select>
          <input value={newArgText} onChange={(e) => setNewArgText(e.target.value)} placeholder="Ваш аргумент" />
          {error && <p className="generation-error">{error}</p>}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleSubmitArgument} disabled={submitting || !newArgText.trim()}>
              {submitting ? 'Отправляем…' : 'Отправить на рассмотрение'}
            </button>
          </div>
        </div>
      )}

      {view.comments.length > 0 && (
        <>
          <p className="steelman-case__label">Комментарии</p>
          <ul className="public-discussion-page__comments">
            {view.comments.map((c) => (
              <li key={c.id} className="public-discussion-page__comment">
                <span className="public-discussion-page__comment-author">{c.participant?.displayName ?? 'Аноним'}:</span> {c.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {joined && (
        <div className="conversations-section__add">
          <input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Ваш комментарий" />
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleComment} disabled={!commentText.trim()}>
              Прокомментировать
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
