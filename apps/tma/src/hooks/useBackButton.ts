'use client';

// MVP-фича 4: useBackButton — нативная кнопка "назад" Telegram вместо
// текстовой ссылки "← Назад". Тот же принцип честного fallback, что и
// в useMainButton: isTelegramAvailable наружу, компонент сам решает,
// показывать ли текстовую ссылку вместо неё.

import { useEffect, useRef } from 'react';
import { getTelegramWebApp, isTelegramWebAppAvailable } from '../lib/telegram';

export function useBackButton(onBack: () => void): { isTelegramAvailable: boolean } {
  const isTelegramAvailable = isTelegramWebAppAvailable();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    const handler = () => onBackRef.current();
    webApp.BackButton.onClick(handler);
    webApp.BackButton.show();

    return () => {
      webApp.BackButton.offClick(handler);
      webApp.BackButton.hide();
    };

  }, []);

  return { isTelegramAvailable };
}
