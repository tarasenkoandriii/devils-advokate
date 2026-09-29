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

      {/* Пункт [device-not-yours] 2026-09-06. Здесь стояло: «Ваши записи
          остаются на вашем устройстве». Это неправда, и неправда на
          САМОМ ПЕРВОМ экране — блокирующем, который человек обязан
          подтвердить, прежде чем что-либо увидеть. Записи лежат на
          сервере: расшифровки, аргументы, разборы, история. Та же фраза
          была найдена и убрана с лендинга пунктом [landing-promise] три
          сверки назад — правило тогда читало только словари лендинга и
          сюда не дотянулось.
          Отдельно скверно, что фраза отсылала «подробнее — в настройках
          приватности», а тот экран говорит ровно обратное: данные
          хранятся, удаление только ручное. Продукт спорил сам с собой,
          и первым человек читал неверное. */}
      <p>
        Сервис создан для подготовки к собственным разговорам — не для слежки за другими.
      </p>

      <p>
        Записи и разборы хранятся на нашем сервере — без этого разбор был бы невозможен. Аудиофайл
        удаляется сразу после расшифровки, остальное остаётся, пока вы сами не удалите: экспорт и
        удаление — в настройках приватности, там же сказано, что и сколько хранится.
      </p>

      {error && <p role="alert" className="generation-error">{error}</p>}

      {!isTelegramAvailable && (
        <button type="button" onClick={handleAcknowledge} disabled={loading}>
          {loading ? 'Сохраняем…' : 'Понимаю и продолжаю'}
        </button>
      )}
    </main>
  );
}
