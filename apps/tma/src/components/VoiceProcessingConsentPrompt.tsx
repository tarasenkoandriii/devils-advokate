'use client';

// Повторный аудит 2026-09-01. Найдено сверкой «что код требует» против
// «что UI умеет выдать»: TextToSpeechService требует
// ConsentType.VOICE_PROCESSING (text-to-speech.service.ts), а выдать
// это согласие было НЕЧЕМ — ни экрана, ни авто-гранта, ни строки в
// dev-сиде. То есть POST /tts отвечал 403 всегда, а SpeakButton в
// четырёх местах ловил ошибку и рисовал «⚠️»: выглядело как «ElevenLabs
// недоступен», хотя ключ на месте и провайдер ни при чём.
//
// Компонент — тот же паттерн, что ThirdPartyAudioConsentPrompt и
// LocationConsentPrompt: спросить один раз в момент, когда функция
// реально нужна, а не собирать согласия авансом на онбординге.
import { useState } from 'react';
import { grantConsent, hasConsent, listConsents } from '../lib/features';
import { haptic } from '../lib/telegram';

const CONSENT_VERSION = 'v1';

interface VoiceProcessingConsentPromptProps {
  source: string;
  onGranted: () => void;
  onCancel: () => void;
}

export function VoiceProcessingConsentPrompt({ source, onGranted, onCancel }: VoiceProcessingConsentPromptProps) {
  const [granting, setGranting] = useState(false);

  async function handleGrant() {
    setGranting(true);
    try {
      await grantConsent({ consentType: 'VOICE_PROCESSING', version: CONSENT_VERSION, source });
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
      <p className="steelman-case__label">Озвучка текста голосом</p>
      <p className="conversations-section__hint">
        Чтобы озвучить подсказку, текст уйдёт внешнему сервису синтеза речи (ElevenLabs). Это текст подсказки, а не
        запись вашего разговора; ваш голос при этом никуда не передаётся. Согласие даётся один раз, отозвать можно в
        настройках приватности.
      </p>
      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleGrant} disabled={granting}>
          {granting ? 'Разрешаем…' : 'Разрешить озвучку'}
        </button>
        <button type="button" onClick={onCancel} disabled={granting}>
          Не сейчас
        </button>
      </div>
    </div>
  );
}

/** Тот же паттерн, что checkThirdPartyAudioConsent(). */
export async function checkVoiceProcessingConsent(): Promise<boolean> {
  try {
    const consents = await listConsents();
    return hasConsent(consents, 'VOICE_PROCESSING');
  } catch {
    return false;
  }
}
