'use client';

// ConsentGate — блокирующий экран перед первым вызовом AI, если
// согласие EXTERNAL_AI ещё не выдано (§3.36 ТЗ — тот же принцип
// прозрачности, что и в дисклеймере при запуске).
//
// MVP-фича 4: кнопка подтверждения — нативная Telegram MainButton,
// с fallback на обычную HTML-кнопку вне Telegram.

import { useState } from 'react';
import { grantConsent, CURRENT_EXTERNAL_AI_CONSENT_VERSION } from '../lib/features';
import { useMainButton } from '../hooks/useMainButton';
import { haptic } from '../lib/telegram';

interface ConsentGateProps {
  onGranted: () => void;
}

export function ConsentGate({ onGranted }: ConsentGateProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant() {
    setLoading(true);
    setError(null);
    try {
      await grantConsent({
        consentType: 'EXTERNAL_AI',
        version: CURRENT_EXTERNAL_AI_CONSENT_VERSION,
        source: 'dilemma-form',
      });
      haptic('success');
      onGranted();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить согласие');
    } finally {
      setLoading(false);
    }
  }

  const { isTelegramAvailable } = useMainButton({
    text: loading ? 'Сохраняем…' : 'Разрешить и продолжить',
    onClick: handleGrant,
    visible: true,
    active: !loading,
    showProgress: loading,
  });

  return (
    <div className="consent-gate">
      <h2>Прежде чем продолжить</h2>
      <p>
        Для генерации аргументов текст вашего вопроса отправляется внешнему AI-провайдеру
        (OpenAI, Anthropic или xAI — в зависимости от выбранного движка). Сам вопрос не
        сохраняется на нашей стороне дольше, чем нужно для одного запроса.
      </p>
      <p>Согласие можно отозвать в любой момент в настройках приватности.</p>
      {error && <p className="consent-gate__error">{error}</p>}

      {!isTelegramAvailable && (
        <button onClick={handleGrant} disabled={loading}>
          {loading ? 'Сохраняем…' : 'Разрешить и продолжить'}
        </button>
      )}
    </div>
  );
}
