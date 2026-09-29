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
import { TruncatedListNotice } from '../../../components/TruncatedListNotice';
import { useParams } from 'next/navigation';
import {
  addPublicComment,
  getPublicDiscussion,
  joinPublicDiscussion,
  submitPublicArgument,
  votePublicSubmission,
} from '../../../lib/public-api';
import { PublicDiscussionView } from '../../../lib/types';
import { ModelParaphrase, ModelWrittenNote } from '../../../components/ModelParaphrase';
import { withdrawPublicComment, withdrawPublicSubmission } from '../../../lib/public-api';
import { ParticipantRightsNote, WithdrawUnavailableNote } from '../../../components/ParticipantRights';

export default function PublicDiscussionPage() {
  const params = useParams();
  const token = typeof params.token === 'string' ? params.token : '';

  const [view, setView] = useState<PublicDiscussionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  // Пункт [badge-was-the-key] 2026-09-24: удостоверение живёт ТОЛЬКО
  // здесь, в памяти вкладки его владельца. `participantId` больше не
  // удостоверение — по нему сервер лишь отмечает «это моё».
  const [withdrawToken, setWithdrawToken] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [joined, setJoined] = useState(false);

  const [newArgText, setNewArgText] = useState('');
  const [newArgStance, setNewArgStance] = useState<'PRO' | 'CON'>('PRO');
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    return getPublicDiscussion(token, participantId)
      .then(setView)
      .catch(() => setNotFound(true));
  }, [token, participantId]);

  useEffect(() => {
    if (!token) return;
    void reload().finally(() => setLoading(false));
  }, [reload, token]);

  async function handleJoin(anonymous: boolean) {
    setError(null);
    try {
      const participant = await joinPublicDiscussion(token, anonymous ? undefined : displayName.trim());
      setParticipantId(participant.id);
      setWithdrawToken(participant.withdrawToken);
      setJoined(true);
    } catch (err) {
      // Пункт [false-success] 2026-09-04. Здесь стояло `setJoined(true)`
      // в обработчике ОШИБКИ: человек вводил имя, нажимал «участвовать»,
      // получал экран участника — а на сервер он не попал, и всё, что он
      // напишет дальше, ушло бы без его имени. Это хуже молчания: экран
      // не промолчал, он СКАЗАЛ НЕПРАВДУ об успехе.
      //
      // Остаться анонимным по-прежнему можно — но по своему выбору, а не
      // потому, что сбой выдали за успех.
      setError(
        `${err instanceof Error ? err.message : 'Не удалось присоединиться под именем'}. Участвовать анонимно можно — аргументы отправятся без имени.`,
      );
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
    setError(null);
    try {
      await votePublicSubmission(token, submissionId, direction);
      await reload();
    } catch (err) {
      // Пункт [false-success] 2026-09-04: «голосование не критично» —
      // это про продукт, а не про человека. Он нажал и видит, что число
      // не изменилось: без объяснения он нажмёт ещё раз, и ещё. Молчание
      // здесь не бережёт его внимание, а тратит.
      setError(err instanceof Error ? `Голос не засчитан: ${err.message}` : 'Голос не засчитан — попробуйте ещё раз позже.');
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

  async function handleWithdrawSubmission(submissionId: string) {
    if (!withdrawToken) return;
    setError(null);
    try {
      await withdrawPublicSubmission(token, submissionId, withdrawToken);
      setView(await getPublicDiscussion(token, participantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось забрать заявку');
    }
  }

  async function handleWithdrawComment(commentId: string) {
    if (!withdrawToken) return;
    setError(null);
    try {
      await withdrawPublicComment(token, commentId, withdrawToken);
      setView(await getPublicDiscussion(token, participantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить комментарий');
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

      {/* Пункт [quotation-marks] 2026-09-05: это читают ПОСТОРОННИЕ по
          ссылке — без аккаунта и без контекста. Они видели «Протокол по
          итогам» и не знали, что его составила модель по расшифровке. */}
      {view.protocol && (
        <div className="public-discussion-page__protocol">
          <p className="steelman-case__label">Протокол по итогам</p>
          <ModelWrittenNote what="Протокол" />
          <p>{view.protocol.summaryText}</p>
        </div>
      )}

      {view.closingMessage && (
        <div className="public-discussion-page__closing">
          <p className="steelman-case__label">Итог</p>
          <ModelWrittenNote what="Итог" />
          <p>{view.closingMessage.summaryText}</p>
          {view.closingMessage.quoteText && (
            <ModelParaphrase
              text={view.closingMessage.quoteText}
              source={view.closingMessage.quoteSourceReference}
            />
          )}
        </div>
      )}

      {/* [false-success] 2026-09-04: сообщение о сбое живёт ЗДЕСЬ, а не
          внутри блока «добавить аргумент». Раньше оно рисовалось только
          после присоединения — то есть сбой ПРИСОЕДИНЕНИЯ показать было
          физически негде, и это одна из причин, по которой его выдавали
          за успех. */}
      {error && <p role="alert" className="generation-error">{error}</p>}

      {!joined && (
        <div className="public-discussion-page__join">
          {/* Пункт [public-name] 2026-09-05: поле «Ваше имя» стояло без
              единого слова о том, где это имя появится. Человек вводил
              его, чтобы представиться автору, — и подписывал им каждый
              свой комментарий для всех, кто откроет ссылку. */}
          <p className="conversations-section__hint">
            Именем подписываются ваши комментарии — их видит каждый, кто откроет эту ссылку. Заявки на аргумент
            показываются без имени, но автор проекта видит, кто их прислал. Можно участвовать анонимно — тогда имя
            не сохраняется вовсе.
          </p>
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
          <TruncatedListNotice hasMore={view.argumentsHasMore} limit={view.pageLimit} what="аргументов" />
        </>
      )}

      {view.submissions.length > 0 && (
        <>
          <p className="steelman-case__label">Заявки участников</p>
          {/* Пункт [right-lived-in-the-tab] 2026-09-25: срок права
              называется там же, где человек пишет, а не в комментарии к
              коду. */}
          <ParticipantRightsNote hasBadge={!!withdrawToken} />
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
                  {/* Пункт [public-name] 2026-09-05: своё можно забрать,
                      пока автор проекта не принял заявку. После принятия
                      она стала аргументом проекта и живёт отдельно —
                      сервер об этом и говорит, вместо того чтобы делать
                      вид, что удалил. */}
                  {withdrawToken && s.mine && s.status === 'PENDING' && (
                    <button type="button" onClick={() => handleWithdrawSubmission(s.id)}>
                      Забрать свою заявку
                    </button>
                  )}
                  {/* Пункт [right-lived-in-the-tab] 2026-09-25: кнопка
                      исчезала молча, и это читалось как поломка. */}
                  {withdrawToken && s.mine && s.status !== 'PENDING' && (
                    <WithdrawUnavailableNote status={s.status as 'ACCEPTED' | 'REJECTED'} />
                  )}
                </div>
              </li>
            ))}
          </ul>
          <TruncatedListNotice hasMore={view.submissionsHasMore} limit={view.pageLimit} what="заявок" />
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
                <span className="public-discussion-page__comment-author">{c.authorName ?? 'Аноним'}:</span> {c.text}
                {/* Пункт [public-name] 2026-09-05: до этой сверки у
                    пришедшего по ссылке не было НИ ОДНОГО способа убрать
                    написанное. Кнопка видна только автору комментария —
                    пока он на этой странице: аккаунта у него нет. */}
                {withdrawToken && c.mine && (
                  <button type="button" onClick={() => handleWithdrawComment(c.id)}>
                    Удалить свой комментарий
                  </button>
                )}
              </li>
            ))}
          </ul>
          <TruncatedListNotice hasMore={view.commentsHasMore} limit={view.pageLimit} what="комментариев" />
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
