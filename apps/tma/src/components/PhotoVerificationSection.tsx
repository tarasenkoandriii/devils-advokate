'use client';

// Пункт 48 (backend) → TMA UI: Photo Verification (§4.4 ТЗ, пункт 33
// v3-роадмапа). Принимает personFactId пропом — САМОСТОЯТЕЛЬНЫЙ,
// готовый к использованию компонент, но в проекте пока НЕТ UI со
// списком PersonFact вообще (честно зафиксировано при построении —
// см. apps/api/prisma/README.md, «Пункт 48») — отдельный, немаленький
// пробел, не решается здесь. Компонент готов к подключению, как
// только появится facts-list UI.
//
// СОГЛАСИЕ ОБЯЗАТЕЛЬНО ПЕРЕД ЗАГРУЗКОЙ — тот же паттерн, что
// ConsentGate.tsx для EXTERNAL_AI, но с ЧЕСТНОЙ, ОТДЕЛЬНОЙ
// формулировкой риска, не переиспользует текст согласия на AI-вызовы:
// фото станет ПУБЛИЧНО ДОСТУПНО В ИНТЕРНЕТЕ по ссылке (не просто
// отправлено на сервер), пусть и ненадолго.

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { grantConsent, listPhotoVerifications, uploadPhotoForVerification } from '../lib/features';
import { PhotoVerification } from '../lib/types';
import { haptic } from '../lib/telegram';

interface PhotoVerificationSectionProps {
  personFactId: string;
}

const CONSENT_VERSION = 'v1';

export function PhotoVerificationSection({ personFactId }: PhotoVerificationSectionProps) {
  const [verifications, setVerifications] = useState<PhotoVerification[]>([]);
  const [loading, setLoading] = useState(true);
  const [consentGranted, setConsentGranted] = useState(false);
  const [grantingConsent, setGrantingConsent] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPhotoVerifications(personFactId)
      .then(setVerifications)
      .catch(() => setVerifications([]))
      .finally(() => setLoading(false));
  }, [personFactId]);

  async function handleGrantConsent() {
    setGrantingConsent(true);
    setError(null);
    try {
      await grantConsent({ consentType: 'PUBLIC_IMAGE_SEARCH', version: CONSENT_VERSION, source: 'photo-verification' });
      setConsentGranted(true);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить согласие');
    } finally {
      setGrantingConsent(false);
    }
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // сброс input — тот же файл можно выбрать повторно
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const results = await uploadPhotoForVerification(personFactId, file);
      setVerifications((prev) => [...results, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось проверить фото');
    } finally {
      setUploading(false);
    }
  }

  if (loading) return null;

  return (
    <section className="photo-verification-section">
      <h3>Проверка фото реверс-поиском</h3>

      {verifications.length > 0 && (
        <ul className="photo-verification-list">
          {verifications.map((v) => (
            <li key={v.id} className="photo-verification-list__item">
              {v.verificationStatus === 'NO_SIMILAR_IMAGES_FOUND' ? (
                <span>Похожих изображений в сети не найдено.</span>
              ) : (
                <>
                  <span className="photo-verification-list__badge">Найдено похожее изображение</span>
                  {v.sourceUrl && (
                    <span>
                      Источник: <a href={v.sourceUrl} target="_blank" rel="noreferrer">{v.sourceUrl}</a>
                    </span>
                  )}
                  {v.sourceDate && <span>Дата источника: {new Date(v.sourceDate).toLocaleDateString('ru-RU')}</span>}
                  {v.matchType && <span className="photo-verification-list__note">{v.matchType}</span>}
                  <span className="photo-verification-list__disclaimer">
                    Это наблюдение, не вывод о подлинности — сравните дату и контекст самостоятельно.
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!consentGranted ? (
        <div className="consent-gate">
          <h2>Прежде чем проверить фото</h2>
          <p>
            Для реверс-поиска это конкретное фото будет НЕНАДОЛГО РАЗМЕЩЕНО ПУБЛИЧНО В ИНТЕРНЕТЕ по ссылке
            (не просто отправлено на наш сервер) — в это время его технически сможет открыть кто угодно,
            у кого окажется ссылка. Ссылка удаляется сразу после завершения поиска.
          </p>
          <p>Согласие можно отозвать в любой момент в настройках приватности.</p>
          {error && <p className="consent-gate__error">{error}</p>}
          <button onClick={handleGrantConsent} disabled={grantingConsent}>
            {grantingConsent ? 'Сохраняем…' : 'Разрешить и продолжить'}
          </button>
        </div>
      ) : (
        <div className="conversations-section__add">
          {error && <p className="generation-error">{error}</p>}
          <label>
            Выберите фото для проверки
            <input type="file" accept="image/*" onChange={handleFileSelected} disabled={uploading} />
          </label>
          {uploading && <p className="conversations-section__hint">Загружаем и ищем…</p>}
        </div>
      )}
    </section>
  );
}
