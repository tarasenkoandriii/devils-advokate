'use client';

// MVP-фича 13 (§3.36 ТЗ, "слово тоже оружие"). Блокирующий экран —
// рендерится ВМЕСТО основного интерфейса, не поверх него, пока
// пользователь явно не подтвердит. Кнопка подтверждения — нативная
// MainButton, с fallback на обычную HTML-кнопку вне Telegram.

import { useState } from 'react';
import { acknowledgeDisclaimer } from '../lib/features';
import { useMainButton } from '../hooks/useMainButton';
import { haptic } from '../lib/telegram';

interface LaunchDisclaimerProps {
  onAcknowledged: () => void;
}

export function LaunchDisclaimer({ onAcknowledged }: LaunchDisclaimerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAcknowledge() {
    setLoading(true);
    setError(null);
    try {
      await acknowledgeDisclaimer();
      haptic('success');
      onAcknowledged();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить подтверждение');
    } finally {
      setLoading(false);
    }
  }

  const { isTelegramAvailable } = useMainButton({
    text: loading ? 'Сохраняем…' : 'Понимаю и продолжаю',
    onClick: handleAcknowledge,
    visible: true,
    active: !loading,
    showProgress: loading,
  });

  return (
    <main className="page disclaimer">
      <h1>Прежде чем начать</h1>

      <p className="disclaimer__lead">Слово тоже оружие.</p>

      <p>
        Devil&apos;s Advocate помогает подготовиться к разговору и даёт реальное преимущество в
        переговорах. Как и любым инструментом влияния, им можно пользоваться и во вред.
      </p>

      <p>
        Если вы делитесь тем, что пользуетесь этим сервисом, — делитесь с друзьями и союзниками, не
        с оппонентом в текущем или будущем споре. Раскрытие того, что вы готовитесь с помощью AI,
        может дать противоположной стороне возможность подготовиться так же — или использовать это
        против вас.
      </p>

      <p>
        Сервис создан для подготовки к собственным разговорам — не для слежки за другими. Ваши
        записи остаются на вашем устройстве (подробнее — в настройках приватности).
      </p>

      {error && <p className="generation-error">{error}</p>}

      {!isTelegramAvailable && (
        <button type="button" onClick={handleAcknowledge} disabled={loading}>
          {loading ? 'Сохраняем…' : 'Понимаю и продолжаю'}
        </button>
      )}
    </main>
  );
}
