'use client';

// Пункт 87 — единый экран согласия на голосовой отпечаток. Тот же
// паттерн, что LocationConsentPrompt.tsx (Пункт 77) — но НАМЕРЕННО
// ОТДЕЛЬНЫЙ компонент, не переиспользование того же UI под другой
// consentType. Голосовой биометрический идентификатор — другая
// категория чувствительности, требует своей явной формулировки, не
// смешанной с геолокацией по формальному сходству паттерна.
//
// ConsentType.VOICE_BIOMETRIC — намеренно ОТДЕЛЬНЫЙ от
// ConsentType.VOICE_PROCESSING (тот про синтез речи, Пункт 63) —
// обоснование в schema.prisma над самим enum'ом.

import { useState } from 'react';
import { grantConsent } from '../lib/features';
import { haptic } from '../lib/telegram';

const CONSENT_VERSION = 'v1';

interface VoiceBiometricConsentPromptProps {
  onGranted: () => void;
  onCancel: () => void;
}

export function VoiceBiometricConsentPrompt({ onGranted, onCancel }: VoiceBiometricConsentPromptProps) {
  const [granting, setGranting] = useState(false);

  async function handleGrant() {
    setGranting(true);
    try {
      await grantConsent({ consentType: 'VOICE_BIOMETRIC', version: CONSENT_VERSION, source: 'onboarding-voice-enrollment' });
      haptic('success');
      onGranted();
    } catch {
      haptic('error');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="voice-biometric-consent-prompt">
      <p className="steelman-case__label">Голосовой отпечаток — экспериментально</p>
      <p className="conversations-section__hint">
        Запись короткого образца вашего голоса, чтобы приложение могло автоматически отличать вас от собеседника во
        время живых сессий — без вопроса «это была ваша реплика?» каждый раз. Хранится не сама запись, а посчитанный
        на вашем устройстве числовой отпечаток. Это отдельная категория данных — можно отозвать в любой момент в
        настройках, отпечаток будет удалён.
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
