'use client';

// ПОВТОРНЫЙ АУДИТ 2026-08-30 — закрывает пробел, который аудит нашёл с
// двух сторон одновременно.
//
// Бэкенд требует ДВА согласия, прежде чем аудио уйдёт AssemblyAI:
// ConsentType.RECORDING (сам факт записи разговора) и
// ConsentType.EPHEMERAL_SERVER (одноразовая передача внешнему
// провайдеру). Проверка была в ConversationsService.requestTranscription()
// и теперь стоит во всех пяти точках, где байты покидают периметр
// (ConsentService.assertAudioMayLeaveDevice).
//
// А в TMA не было НИ ОДНОГО места, где эти два согласия выдаются:
// grantConsent() вызывался для EXTERNAL_AI, LOCATION, VOICE_BIOMETRIC,
// THIRD_PARTY_AUDIO_RECORDING, PUBLIC_SHARING, PUBLIC_IMAGE_SEARCH — но
// не для RECORDING/EPHEMERAL_SERVER. То есть загрузка разговора
// гарантированно упиралась в 403, и единственным «объяснением»
// пользователю была строчка в catch: «проверьте согласие на запись в
// Центре приватности» — при том что выдать его там тоже нельзя.
//
// Тот же паттерн компонента, что ThirdPartyAudioConsentPrompt.tsx:
// экран-гейт + функция проверки, чтобы вызывающий код мог решить, надо
// ли его показывать.

import { useState } from 'react';
import { grantConsent, hasConsent, listConsents } from '../lib/features';
import { haptic } from '../lib/telegram';

const CONSENT_VERSION = 'v1';

interface AudioProcessingConsentPromptProps {
  source: string;
  onGranted: () => void;
  onCancel: () => void;
}

export function AudioProcessingConsentPrompt({ source, onGranted, onCancel }: AudioProcessingConsentPromptProps) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant() {
    setGranting(true);
    setError(null);
    try {
      // Два отдельных согласия, а не одно «на всё»: они означают разное
      // и отзываются независимо. RECORDING — про сам факт работы с
      // записью разговора; EPHEMERAL_SERVER — про то, что файл
      // физически уходит стороннему сервису. Пользователь, готовый
      // хранить запись у себя, вправе не соглашаться на второе.
      await grantConsent({ consentType: 'RECORDING', version: CONSENT_VERSION, source });
      await grantConsent({ consentType: 'EPHEMERAL_SERVER', version: CONSENT_VERSION, source });
      haptic('success');
      onGranted();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить согласие');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="location-consent-prompt">
      <p className="steelman-case__label">Обработка записи разговора</p>
      <p className="conversations-section__hint">
        Чтобы расшифровать разговор и разделить реплики по говорящим, файл передаётся внешнему сервису
        распознавания речи (AssemblyAI). Он обрабатывает запись и возвращает текст; на нашей стороне
        сохраняется расшифровка, а не сам файл. Запись может содержать голос собеседника — убедитесь, что
        она получена законно.
      </p>
      <p className="conversations-section__hint">
        Согласие отзывается в любой момент в настройках приватности. В режиме «Максимальная приватность»
        облачная расшифровка недоступна вовсе — это не обходится согласием.
      </p>
      {error && <p className="conversations-section__error">{error}</p>}
      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleGrant} disabled={granting}>
          {granting ? 'Разрешаем…' : 'Разрешить и продолжить'}
        </button>
        <button type="button" onClick={onCancel} disabled={granting}>
          Не сейчас
        </button>
      </div>
    </div>
  );
}

/** Оба согласия обязательны — одного мало, бэкенд требует их вместе
 * (ConsentService.assertAudioMayLeaveDevice). Тот же паттерн, что
 * checkThirdPartyAudioConsent(). */
export async function checkAudioProcessingConsent(): Promise<boolean> {
  try {
    const consents = await listConsents();
    return hasConsent(consents, 'RECORDING') && hasConsent(consents, 'EPHEMERAL_SERVER');
  } catch {
    return false;
  }
}
