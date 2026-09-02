'use client';

// Пункт [ai-errors-ui] 2026-09-02 — ИСПРАВЛЕНИЕ АУДИТА.
//
// НАЙДЕНО. Доменные экраны печатали текст любой ошибки как есть. Для
// отсутствия согласия это означало английскую служебную строку с
// внутренним id пользователя вместо экрана согласия:
//
//   Consent required: EXTERNAL_AI (userId=ckx…, projectId=ckz…)
//
// Гейт согласия стоит только там, где домен объявил requiredConsent (а
// это один health), поэтому любой, кто зашёл на /domains минуя главную
// и квиз, получал это на первом же AI-действии. На главной ровно этот
// случай обработан правильно (app/page.tsx: 403 → ConsentGate) —
// доменные экраны отстали.
//
// Здесь один компонент на все доменные панели: 403 — это не сбой, а
// недостающее разрешение, и лечится оно кнопкой, а не обращением в
// поддержку.
import { ApiRequestError } from '../../lib/api';
import { ConsentGate } from '../ConsentGate';

export function AiErrorNotice({ error, onConsentGranted }: { error: unknown; onConsentGranted?: () => void }) {
  if (!error) return null;

  const httpStatus = error instanceof ApiRequestError ? error.httpStatus : null;
  const message = error instanceof Error ? error.message : String(error);

  if (httpStatus === 403 && /consent/i.test(message)) {
    return (
      <div className="domain-panel">
        <p>Для этого действия нужно ваше согласие на обработку через внешний AI-сервис.</p>
        <ConsentGate onGranted={() => onConsentGranted?.()} />
      </div>
    );
  }

  // 503 «нет модели» и 429 «лимит» теперь доезжают со своим текстом
  // (см. common/ai-error-passthrough.ts на бэкенде) — показываем его,
  // он объясняет, что делать, лучше любой нашей подстановки.
  return <p className="generation-error">{message}</p>;
}
