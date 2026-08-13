import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { TelegramInit } from './telegram-init';
import { AppGate } from '../components/AppGate';
import './globals.css';

export const metadata: Metadata = {
  title: "Devil's Advocate",
  description: 'Подготовка к разговору, который приведёт к нужному решению',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        {/* Официальный Telegram WebApp SDK — обязателен для window.Telegram.WebApp,
         * который используется в lib/telegram.ts. beforeInteractive гарантирует,
         * что скрипт готов до первого рендера клиентских компонентов. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body>
        <TelegramInit />
        {/* AppGate — единственная точка проверки дисклеймера для ВСЕГО
         * дерева страниц (см. комментарий в AppGate.tsx). Раньше эта
         * проверка жила только внутри app/page.tsx — реальный пробел,
         * закрытый именно оборачиванием на уровне layout, а не
         * дублированием проверки в каждой отдельной странице. */}
        <AppGate>{children}</AppGate>
      </body>
    </html>
  );
}
