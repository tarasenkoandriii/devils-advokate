'use client';

// Пункт 63 (backend) → TMA UI: кнопка озвучки текста через ElevenLabs
// (пункт 43 общего списка v4-роадмапа). Намеренно маленький,
// изолированный компонент, принимающий произвольный text — вставляется
// одной строкой в любое место, где уже есть короткий сгенерированный
// текст-подсказка, не требует правок в самой логике компонента-
// хозяина. Первая точка использования — bestNextMove.bestAction в
// ConversationsSection.tsx.

import { useState } from 'react';
import { synthesizeSpeech } from '../lib/features';
import { haptic } from '../lib/telegram';
import { VoiceProcessingConsentPrompt, checkVoiceProcessingConsent } from './VoiceProcessingConsentPrompt';

interface SpeakButtonProps {
  text: string;
}

export function SpeakButton({ text }: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Повторный аудит 2026-09-01: backend требует VOICE_PROCESSING, а
  // выдать это согласие в приложении было негде — POST /tts отвечал 403
  // всегда, и кнопка молча показывала «⚠️», как будто недоступен
  // ElevenLabs. Спрашиваем ровно в момент нажатия, тем же паттерном,
  // что живой звук и геолокация.
  const [needsConsent, setNeedsConsent] = useState(false);

  async function handleClick() {
    // play() возвращает промис и отклоняется, когда браузер блокирует
    // автовоспроизведение. Раньше отказ уходил в unhandled rejection:
    // кнопка показывала «озвучено», звука не было, следа тоже.
    if (audioUrl) {
      try {
        await new Audio(audioUrl).play();
      } catch {
        haptic('error');
        setError(true);
      }
      return;
    }
    if (!(await checkVoiceProcessingConsent())) {
      setNeedsConsent(true);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const result = await synthesizeSpeech(text);
      const url = `data:audio/mpeg;base64,${result.audioBase64}`;
      setAudioUrl(url);
      await new Audio(url).play();
      haptic('light');
    } catch {
      haptic('error');
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (needsConsent) {
    return (
      <VoiceProcessingConsentPrompt
        source="speak-button"
        onGranted={() => { setNeedsConsent(false); void handleClick(); }}
        onCancel={() => setNeedsConsent(false)}
      />
    );
  }

  return (
    <button type="button" className="speak-button" onClick={() => void handleClick()} disabled={loading} title="Озвучить">
      {loading ? '…' : error ? '⚠️' : '🔊'}
    </button>
  );
}
