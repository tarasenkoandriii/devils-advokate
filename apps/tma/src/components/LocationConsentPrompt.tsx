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
import { LOCATION_PURPOSES, locationConsentText } from '../lib/location-purposes';
import { haptic } from '../lib/telegram';
import { reportFailure } from '../lib/failure-report';

const CONSENT_VERSION = 'v1';

// Пункт [consent-purpose] 2026-09-05. Здесь стоял ОДИН список из трёх
// применений и один текст на все случаи. Проблема была не в списке —
// он верен, — а в том, что этой же записью согласия открывались ещё
// два места, где координаты сохраняются навсегда: сервер не смотрел в
// `purposes` вовсе. Теперь применения — вход компонента, а текст
// считается из них.
const DEFAULT_PURPOSES: string[] = [
  LOCATION_PURPOSES.ONBOARDING_CITY,
  LOCATION_PURPOSES.WEATHER,
  LOCATION_PURPOSES.VENUE_SEARCH,
];

interface LocationConsentPromptProps {
  source: string; // откуда запрошено — для аудита (§3.36 "слово тоже оружие", прозрачность)
  /** Применения, на которые спрашивают согласие. Не подмешиваются к
   * умолчанию, а ЗАМЕНЯЮТ его: экран, которому нужна геометка на
   * доказательстве, не должен заодно выпрашивать погоду. */
  purposes?: readonly string[];
  onGranted: () => void;
  onCancel: () => void;
}

/** Компонент-гейт: показывает объяснение всех трёх применений
 * геолокации и просит согласие один раз. Используется ПЕРЕД первым
 * вызовом navigator.geolocation в каждом из трёх мест. */
export function LocationConsentPrompt({ source, purposes, onGranted, onCancel }: LocationConsentPromptProps) {
  const [granting, setGranting] = useState(false);
  const asked = purposes && purposes.length > 0 ? [...purposes] : DEFAULT_PURPOSES;

  async function handleGrant() {
    setGranting(true);
    try {
      await grantConsent({ consentType: 'LOCATION', version: CONSENT_VERSION, source, purposes: asked });
      haptic('success');
      onGranted();
    } catch (err) {
      // Пункт [one-buzz-was-the-whole-answer] 2026-09-24. Здесь
      // стояла одна вибрация. Экран согласия — худшее место для
      // такого молчания: человек нажал «согласен», запрос упал, и
      // он уходит, не зная, записано согласие или нет.
      reportFailure(err, 'Не удалось записать согласие на геолокацию');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="location-consent-prompt">
      <p className="steelman-case__label">Доступ к геолокации</p>
      <p className="conversations-section__hint">{locationConsentText(asked)}</p>
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
export async function checkLocationConsent(purpose?: string): Promise<boolean> {
  try {
    const consents = await listConsents();
    if (purpose === undefined) return hasConsent(consents, 'LOCATION');
    // Пункт [consent-purpose] 2026-09-05: клиентская проверка обязана
    // повторять серверную. Если она мягче, экран не покажет вопрос, а
    // сервер откажет — человек получит отказ вместо вопроса.
    return consents.some((c) => c.consentType === 'LOCATION' && c.granted && Array.isArray(c.purposes) && c.purposes.includes(purpose));
  } catch {
    return false;
  }
}
