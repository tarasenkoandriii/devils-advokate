'use client';

import { useEffect } from 'react';
import { initTelegramWebApp } from '../lib/telegram';

/** Отдельный клиентский компонент, а не побочный эффект прямо в
 * серверном RootLayout — App Router требует явного разделения
 * серверных и клиентских частей дерева, layout.tsx сам по себе
 * серверный компонент (использует Metadata export). */
export function TelegramInit() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  return null;
}
