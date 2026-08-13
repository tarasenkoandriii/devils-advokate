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

interface SpeakButtonProps {
  text: string;
}

export function SpeakButton({ text }: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function handleClick() {
    if (audioUrl) {
      new Audio(audioUrl).play();
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const result = await synthesizeSpeech(text);
      const url = `data:audio/mpeg;base64,${result.audioBase64}`;
      setAudioUrl(url);
      new Audio(url).play();
      haptic('light');
    } catch {
      haptic('error');
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button type="button" className="speak-button" onClick={handleClick} disabled={loading} title="Озвучить">
      {loading ? '…' : error ? '⚠️' : '🔊'}
    </button>
  );
}
