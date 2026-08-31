'use client';

// Согласие, требуемое доменом до создания проекта (health → HEALTH_DATA).
// Та же дисциплина, что у ConsentGate/LocationConsentPrompt: отдельная
// явная формулировка, не переиспользование EXTERNAL_AI.
import { useEffect, useState } from 'react';
import { grantConsent, hasConsent, listConsents } from '../../lib/features';
import { ConsentType } from '../../lib/types';

const TEXTS: Record<string, { title: string; body: string; version: string }> = {
  HEALTH_DATA: {
    title: 'Данные о здоровье',
    body: 'Вы собираетесь описывать состояние здоровья, рекомендации врачей и анализы. Это особая категория данных: она используется только для разбора консультаций в этом проекте, передаётся внешнему AI-провайдеру только с вашим согласием и удаляется вместе с проектом. Приложение не ставит диагнозов и не заменяет врача.',
    version: 'health-data-v1',
  },
};

export function DomainConsentGate({ consentType, children }: { consentType: string; children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'needed' | 'granted'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listConsents()
      .then((list) => setState(hasConsent(list, consentType as ConsentType) ? 'granted' : 'needed'))
      .catch(() => setState('needed'));
  }, [consentType]);

  if (state === 'loading') return <p>Загрузка…</p>;
  if (state === 'granted') return <>{children}</>;
  const t = TEXTS[consentType] ?? { title: consentType, body: 'Требуется отдельное согласие.', version: 'v1' };
  return (
    <div className="consent-gate">
      <h3>{t.title}</h3>
      <p>{t.body}</p>
      {error && <p className="generation-error">{error}</p>}
      <button type="button" className="primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await grantConsent({ consentType: consentType as ConsentType, version: t.version, source: 'domain-gate' }); setState('granted'); }
        catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить согласие'); }
        finally { setBusy(false); }
      }}>Согласен(на), продолжить</button>
    </div>
  );
}
