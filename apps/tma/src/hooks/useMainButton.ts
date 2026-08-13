'use client';

// MVP-фича 4: useMainButton — нативная кнопка Telegram вместо обычной
// HTML-кнопки. isTelegramAvailable возвращается наружу явно —
// компонент, использующий хук, обязан сам отрендерить обычную HTML-
// кнопку, если false, иначе локальная разработка вне Telegram (где
// MainButton физически не существует) станет немой: нечем нажать.
// Оба пути явно видны в коде компонента, использующего хук (см.
// DilemmaForm.tsx, ConsentGate.tsx).

import { useEffect, useRef } from 'react';
import { getTelegramWebApp, isTelegramWebAppAvailable } from '../lib/telegram';

export interface UseMainButtonOptions {
  text: string;
  onClick: () => void;
  visible: boolean;
  active: boolean;
  showProgress?: boolean;
}

export function useMainButton(options: UseMainButtonOptions): { isTelegramAvailable: boolean } {
  const isTelegramAvailable = isTelegramWebAppAvailable();
  const onClickRef = useRef(options.onClick);
  onClickRef.current = options.onClick;

  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    const handler = () => onClickRef.current();
    webApp.MainButton.onClick(handler);

    return () => {
      webApp.MainButton.offClick(handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    webApp.MainButton.setText(options.text);
    if (options.visible) {
      webApp.MainButton.show();
    } else {
      webApp.MainButton.hide();
    }
    if (options.active) {
      webApp.MainButton.enable();
    } else {
      webApp.MainButton.disable();
    }
    if (options.showProgress) {
      webApp.MainButton.showProgress(false);
    } else {
      webApp.MainButton.hideProgress();
    }
  }, [options.text, options.visible, options.active, options.showProgress]);

  useEffect(() => {
    return () => {
      const webApp = getTelegramWebApp();
      webApp?.MainButton.hide();
    };
  }, []);

  return { isTelegramAvailable };
}
