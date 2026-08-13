'use client';

// Пункт 66 (backend) → TMA UI: очередь модерации заявок заведений
// (§3.23 ТЗ). Доступна только пользователям с User.isVenueModerator —
// не self-service, тот же паттерн, что /library/moderate (Пункт 57).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listVenueModerationQueue, moderateVenueApplication } from '../../../lib/features';
import { VenueApplication } from '../../../lib/types';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function VenueModerationPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<VenueApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [feeInputs, setFeeInputs] = useState<Record<string, string>>({});

  useBackButton(() => router.push('/'));

  function reload() {
    return listVenueModerationQueue()
      .then(setApplications)
      .catch(() => setForbidden(true));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleModerate(applicationId: string, decision: 'APPROVE' | 'REJECT') {
    try {
      const feeText = feeInputs[applicationId];
      const referralFeeAmount = decision === 'APPROVE' && feeText ? parseFloat(feeText) : undefined;
      await moderateVenueApplication(applicationId, decision, referralFeeAmount);
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
        <h2>Очередь модерации заведений</h2>
        <p>Эта страница доступна только модераторам заведений.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h2>Очередь модерации заведений</h2>
      {applications.length === 0 ? (
        <p className="conversations-section__hint">Заявок на модерации нет.</p>
      ) : (
        <ul className="venue-moderation-list">
          {applications.map((app) => (
            <li key={app.id} className="venue-moderation-list__item">
              <h3>{app.name}</h3>
              <p className="conversations-section__hint">{app.address}</p>
              {app.phone && <p className="conversations-section__hint">{app.phone}</p>}
              <label>
                Реферальная плата за бронь (необязательно)
                <input
                  type="number"
                  value={feeInputs[app.id] ?? ''}
                  onChange={(e) => setFeeInputs({ ...feeInputs, [app.id]: e.target.value })}
                  placeholder="Например: 5"
                />
              </label>
              <div className="conversations-section__add-actions">
                <button type="button" onClick={() => handleModerate(app.id, 'APPROVE')}>
                  Одобрить
                </button>
                <button type="button" onClick={() => handleModerate(app.id, 'REJECT')}>
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
