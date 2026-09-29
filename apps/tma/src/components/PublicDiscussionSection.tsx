'use client';

// Пункт 56 (backend) → TMA UI: Public Discussion, owner-side (§4.5
// ТЗ). Управление ссылкой + очередь модерации. Публичная сторона
// (для тех, кто перешёл по ссылке) — отдельная страница вне TMA,
// /public/[token]/page.tsx, использует lib/public-api.ts, не эту секцию.

import { useState, useEffect, useCallback } from 'react';
import { SectionLoadError } from './SectionLoadError';
import { TruncatedListNotice } from './TruncatedListNotice';
import {
  disablePublicSharing,
  enablePublicSharing,
  grantConsent,
  listPublicSubmissionsForModeration,
  moderatePublicSubmission,
} from '../lib/features';
import { OwnerPublicSubmission } from '../lib/types';
import { ApiRequestError } from '../lib/api';
import { haptic } from '../lib/telegram';
import { reportFailure } from '../lib/failure-report';

interface PublicDiscussionSectionProps {
  projectId: string;
  publicShareToken: string | null;
}

export function PublicDiscussionSection({ projectId, publicShareToken: initialToken }: PublicDiscussionSectionProps) {
  const [token, setToken] = useState(initialToken);
  const [submissions, setSubmissions] = useState<OwnerPublicSubmission[]>([]);
  // Сверка чтений без потолка 2026-09-04: список заявок обрезан потолком.
  const [submissionsHasMore, setSubmissionsHasMore] = useState(false);
  const [pageLimit, setPageLimit] = useState(0);
  // И там же: сбой загрузки заявок гасился в пустой список — модератор
  // видел «заявок нет» вместо «не удалось загрузить». Тот же класс, что
  // закрывал заход [silent-failure-sweep]; этот экран он не задел.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Аудит БД 2026-08-30, §2.3 — ConsentType.PUBLIC_SHARING раньше ничем не
  // требовался, включение делало проект читаемым по токену без согласия.
  const [needsConsent, setNeedsConsent] = useState(false);
  const [grantingConsent, setGrantingConsent] = useState(false);

  const reload = useCallback(() => {
    if (!token) {
      setSubmissions([]);
      return Promise.resolve();
    }
    setLoadFailed(false);
    return listPublicSubmissionsForModeration(projectId)
      .then((page) => {
        setSubmissions(page.items);
        setSubmissionsHasMore(page.hasMore);
        setPageLimit(page.limit);
      })
      .catch(() => {
        setSubmissions([]);
        setLoadFailed(true);
      });
  }, [projectId, token]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  async function handleEnable() {
    setToggling(true);
    setError(null);
    try {
      const result = await enablePublicSharing(projectId);
      setToken(result.publicShareToken);
      haptic('success');
    } catch (err) {
      haptic('error');
      // Пункт [error-language] 2026-09-04: опознаём по устойчивому коду,
      // а не по подстроке в тексте. Раньше экран зависел от того, что API
      // вернёт английскую строку со словом PUBLIC_SHARING внутри, — то
      // есть текст сообщения был негласным контрактом, и перевод этого
      // сообщения на русский молча сломал бы согласие.
      if (
        err instanceof ApiRequestError &&
        err.code === 'CONSENT_REQUIRED' &&
        err.details?.consentType === 'PUBLIC_SHARING'
      ) {
        setNeedsConsent(true);
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось включить публичное обсуждение');
      }
    } finally {
      setToggling(false);
    }
  }

  async function handleGrantAndEnable() {
    setGrantingConsent(true);
    setError(null);
    try {
      await grantConsent({ consentType: 'PUBLIC_SHARING', version: 'v1', source: 'public-discussion-section' });
      setNeedsConsent(false);
      await handleEnable();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить согласие');
    } finally {
      setGrantingConsent(false);
    }
  }

  async function handleDisable() {
    setToggling(true);
    setError(null);
    try {
      await disablePublicSharing(projectId);
      setToken(null);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось выключить публичное обсуждение');
    } finally {
      setToggling(false);
    }
  }

  async function handleModerate(submissionId: string, decision: 'ACCEPT' | 'REJECT') {
    try {
      await moderatePublicSubmission(projectId, submissionId, decision);
      await reload();
      haptic('success');
    } catch (err) {
      reportFailure(err, 'Не удалось рассмотреть заявку');
    }
  }

  if (loading) return null;

  const publicUrl = token && typeof window !== 'undefined' ? `${window.location.origin}/public/${token}` : null;
  const pendingSubmissions = submissions.filter((s) => s.status === 'PENDING');

  return (
    <section className="public-discussion-section">
      <h3>Публичное обсуждение</h3>
      <p className="conversations-section__hint">
        Участники по ссылке видят только ваши аргументы (за/против), не факты и не документы — первоисточники
        остаются закрытыми. Вы решаете, какие публичные аргументы принять в основной список.
      </p>

      {token ? (
        <>
          {publicUrl && (
            <p className="public-discussion-section__link">
              Ссылка для публикации: <code>{publicUrl}</code>
            </p>
          )}
          {error && <p role="alert" className="generation-error">{error}</p>}
          <button type="button" onClick={handleDisable} disabled={toggling}>
            {toggling ? 'Выключаем…' : 'Выключить публичное обсуждение'}
          </button>

          {loadFailed && (
            <SectionLoadError
              what="заявки участников"
              hint="заявок нет — возможно, они есть и ждут вашего решения"
            />
          )}

          {pendingSubmissions.length > 0 && (
            <>
              <p className="steelman-case__label">На модерации ({pendingSubmissions.length})</p>
              <TruncatedListNotice hasMore={submissionsHasMore} limit={pageLimit} what="заявок" />
              <ul className="public-discussion-section__moderation-list">
                {pendingSubmissions.map((s) => (
                  <li key={s.id} className="public-discussion-section__moderation-item">
                    <span>({s.stance}) {s.text}</span>
                    <span className="conversations-section__hint">
                      от {s.participant?.displayName ?? 'анонимного участника'}, 👍 {s.upvotes} 👎 {s.downvotes}
                    </span>
                    <div className="conversations-section__add-actions">
                      <button type="button" onClick={() => handleModerate(s.id, 'ACCEPT')}>
                        Принять
                      </button>
                      <button type="button" onClick={() => handleModerate(s.id, 'REJECT')}>
                        Отклонить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : needsConsent ? (
        <div className="conversations-section__add-actions">
          <p className="conversations-section__hint">
            Публичное обсуждение делает ваши аргументы доступными по ссылке любому, у кого она есть — без входа в
            приложение. Согласие нужно один раз, отозвать можно в любой момент, выключив обсуждение.
          </p>
          {error && <p role="alert" className="generation-error">{error}</p>}
          <button type="button" onClick={handleGrantAndEnable} disabled={grantingConsent}>
            {grantingConsent ? 'Включаем…' : 'Согласен(на), включить'}
          </button>
          <button type="button" onClick={() => setNeedsConsent(false)} disabled={grantingConsent}>
            Не сейчас
          </button>
        </div>
      ) : (
        <div className="conversations-section__add-actions">
          {error && <p role="alert" className="generation-error">{error}</p>}
          <button type="button" onClick={handleEnable} disabled={toggling}>
            {toggling ? 'Включаем…' : 'Включить публичное обсуждение'}
          </button>
        </div>
      )}
    </section>
  );
}
