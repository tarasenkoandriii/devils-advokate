'use client';

// Пункт 56 (backend) → TMA UI: Public Discussion, owner-side (§4.5
// ТЗ). Управление ссылкой + очередь модерации. Публичная сторона
// (для тех, кто перешёл по ссылке) — отдельная страница вне TMA,
// /public/[token]/page.tsx, использует lib/public-api.ts, не эту секцию.

import { useEffect, useState } from 'react';
import {
  disablePublicSharing,
  enablePublicSharing,
  listPublicSubmissionsForModeration,
  moderatePublicSubmission,
} from '../lib/features';
import { PublicArgumentSubmission } from '../lib/types';
import { haptic } from '../lib/telegram';

interface PublicDiscussionSectionProps {
  projectId: string;
  publicShareToken: string | null;
}

export function PublicDiscussionSection({ projectId, publicShareToken: initialToken }: PublicDiscussionSectionProps) {
  const [token, setToken] = useState(initialToken);
  const [submissions, setSubmissions] = useState<PublicArgumentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    if (!token) {
      setSubmissions([]);
      return Promise.resolve();
    }
    return listPublicSubmissionsForModeration(projectId)
      .then(setSubmissions)
      .catch(() => setSubmissions([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, token]);

  async function handleEnable() {
    setToggling(true);
    setError(null);
    try {
      const result = await enablePublicSharing(projectId);
      setToken(result.publicShareToken);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось включить публичное обсуждение');
    } finally {
      setToggling(false);
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
    } catch {
      haptic('error');
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
          {error && <p className="generation-error">{error}</p>}
          <button type="button" onClick={handleDisable} disabled={toggling}>
            {toggling ? 'Выключаем…' : 'Выключить публичное обсуждение'}
          </button>

          {pendingSubmissions.length > 0 && (
            <>
              <p className="steelman-case__label">На модерации ({pendingSubmissions.length})</p>
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
      ) : (
        <div className="conversations-section__add-actions">
          {error && <p className="generation-error">{error}</p>}
          <button type="button" onClick={handleEnable} disabled={toggling}>
            {toggling ? 'Включаем…' : 'Включить публичное обсуждение'}
          </button>
        </div>
      )}
    </section>
  );
}
