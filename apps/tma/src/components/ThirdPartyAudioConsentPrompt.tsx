'use client';

// Аудит моделей БД 2026-08-30, §2.3 — mintTranscriptionToken() открывает
// прямой канал browser→AssemblyAI: живой звук разговора (включая голос
// собеседника, не только пользователя) стримится внешнему провайдеру в
// реальном времени. ConsentType.THIRD_PARTY_AUDIO_RECORDING — тот же
// принцип, что уже применён в DtpEvidence (запись чужого голоса без его
// осведомлённости), просто вынесен на уровень входа в любую live-фичу.
// Тот же паттерн компонента, что LocationConsentPrompt.tsx.
import { useState } from 'react';
import { grantConsent, hasConsent, listConsents } from '../lib/features';
import { haptic } from '../lib/telegram';

const CONSENT_VERSION = 'v1';

interface ThirdPartyAudioConsentPromptProps {
  source: string;
  onGranted: () => void;
  onCancel: () => void;
}

export function ThirdPartyAudioConsentPrompt({ source, onGranted, onCancel }: ThirdPartyAudioConsentPromptProps) {
  const [granting, setGranting] = useState(false);

  async function handleGrant() {
    setGranting(true);
    try {
      await grantConsent({ consentType: 'THIRD_PARTY_AUDIO_RECORDING', version: CONSENT_VERSION, source });
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
      <p className="steelman-case__label">Запись живого звука разговора</p>
      <p className="conversations-section__hint">
        Эта функция передаёт звук разговора внешнему провайдеру распознавания речи (AssemblyAI) в реальном времени —
        включая голос собеседника, который может не знать об этом. Убедитесь, что запись разговора законна в вашей
        ситуации, и по возможности предупредите собеседника. Согласие даётся один раз, отозвать можно в настройках.
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

/** Простая проверка — тот же паттерн, что checkLocationConsent(). */
export async function checkThirdPartyAudioConsent(): Promise<boolean> {
  try {
    const consents = await listConsents();
    return hasConsent(consents, 'THIRD_PARTY_AUDIO_RECORDING');
  } catch {
    return false;
  }
}
