'use client';

// Пункт 77 (§3.32 ТЗ) — единый экран согласия на геолокацию.
// "Один экран согласия, а не разрозненные пуш-запросы в разных
// местах — объясняет сразу все возможные применения" (буквально ТЗ).
// Переиспользуется тремя местами (онбординг, погода, заведения) —
// одна и та же формулировка везде, не три разных текста согласия.
//
// Backend-инфраструктура (ConsentRecord с purposes[], grant/revoke)
// уже была построена ЗАДОЛГО до этого пункта — ConsentService.revoke()
// содержал прямой комментарий про §3.32 с самого начала. Здесь только
// клиентская обёртка поверх уже готового API.

import { useState } from 'react';
import { grantConsent, hasConsent, listConsents } from '../lib/features';
import { haptic } from '../lib/telegram';

const CONSENT_VERSION = 'v1';
const PURPOSES = ['onboarding-city-hint', 'weather-forecast', 'venue-search'];

interface LocationConsentPromptProps {
  source: string; // откуда запрошено — для аудита (§3.36 "слово тоже оружие", прозрачность)
  onGranted: () => void;
  onCancel: () => void;
}

/** Компонент-гейт: показывает объяснение всех трёх применений
 * геолокации и просит согласие один раз. Используется ПЕРЕД первым
 * вызовом navigator.geolocation в каждом из трёх мест. */
export function LocationConsentPrompt({ source, onGranted, onCancel }: LocationConsentPromptProps) {
  const [granting, setGranting] = useState(false);

  async function handleGrant() {
    setGranting(true);
    try {
      await grantConsent({ consentType: 'LOCATION', version: CONSENT_VERSION, source, purposes: PURPOSES });
      haptic('success');
      onGranted();
    } catch {
      haptic('error');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="location-consent-prompt">
      <p className="steelman-case__label">Доступ к геолокации</p>
      <p className="conversations-section__hint">
        Один раз разрешить использование геолокации для: подсказки страны/города при первом входе, прогноза погоды
        для запланированных встреч, поиска заведений рядом. Координаты никогда не сохраняются — только разовое
        использование для каждого запроса. Разрешение можно отозвать в любой момент в настройках.
      </p>
      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleGrant} disabled={granting}>
          {granting ? 'Разрешаем…' : 'Разрешить'}
        </button>
        <button type="button" onClick={onCancel} disabled={granting}>
          Не сейчас
        </button>
      </div>
    </div>
  );
}

/** Простая проверка текущего статуса согласия — используется
 * компонентами перед вызовом navigator.geolocation напрямую, без
 * лишней хук-абстракции (каждый компонент сам хранит своё локальное
 * состояние "жду согласия, потом продолжу"). */
export async function checkLocationConsent(): Promise<boolean> {
  try {
    const consents = await listConsents();
    return hasConsent(consents, 'LOCATION');
  } catch {
    return false;
  }
}
