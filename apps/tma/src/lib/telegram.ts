// apps/tma: обёртка над Telegram WebApp SDK.
//
// В реальном запуске внутри Telegram window.Telegram.WebApp существует
// и содержит initData, готовый к отправке в X-Telegram-Init-Data
// (валидируется на бэкенде в telegram-init-data.util.ts — тот же формат).
//
// DEV-режим: если window.Telegram недоступен (обычная разработка в
// браузере вне Telegram), используем NEXT_PUBLIC_DEV_USER_ID и
// заголовок X-Dev-User-Id — зеркально DEV bypass на бэкенде
// (ALLOW_DEV_AUTH=true). Без этого локальная разработка TMA-экранов
// вне самого Telegram невозможна вообще.
//
// MVP-фича 4 (Telegram-native UX): расширено MainButton/BackButton/
// HapticFeedback/тема — компоненты используют их вместо обычных HTML-
// кнопок и текстовых ссылок "назад", когда доступен реальный Telegram
// WebApp, и падают обратно на обычные HTML-элементы вне его (иначе
// локальная разработка в браузере вне Telegram становится немой —
// нечем нажать, если единственный способ отправить форму — MainButton,
// которого в браузере нет).

export interface TelegramMainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show: () => void;
  hide: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
}

export interface TelegramHapticFeedback {
  impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
  notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged: () => void;
}

export interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  HapticFeedback: TelegramHapticFeedback;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  openTelegramLink: (url: string) => void;
  onEvent: (event: string, cb: () => void) => void;
  offEvent: (event: string, cb: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function isTelegramWebAppAvailable(): boolean {
  return getTelegramWebApp() !== null;
}

export function initTelegramWebApp(): void {
  const webApp = getTelegramWebApp();
  if (webApp) {
    webApp.ready();
    webApp.expand();
    // Применяем тему хоста сразу при инициализации — заголовок и фон
    // должны совпадать с темой Telegram-клиента (light/dark), а не
    // оставаться захардкоженными в CSS независимо от неё.
    if (webApp.themeParams.bg_color) {
      webApp.setBackgroundColor(webApp.themeParams.bg_color);
    }
    const headerColor = webApp.themeParams.header_bg_color ?? webApp.themeParams.bg_color;
    if (headerColor) {
      webApp.setHeaderColor(headerColor);
    }
  }
}

/** Заголовки авторизации для API-запросов — реальный initData внутри
 * Telegram, DEV-заголовок вне его. Один источник правды для всего
 * фронтенда, не дублируется в каждом месте, где идёт fetch. */
export function getAuthHeaders(): Record<string, string> {
  const webApp = getTelegramWebApp();
  if (webApp?.initData) {
    return { 'X-Telegram-Init-Data': webApp.initData };
  }

  const devUserId = process.env.NEXT_PUBLIC_DEV_USER_ID;
  if (devUserId) {
    // eslint-disable-next-line no-console
    console.warn(
      `[DEV] Telegram WebApp недоступен — используется X-Dev-User-Id=${devUserId}. Не должно происходить в production-сборке.`,
    );
    return { 'X-Dev-User-Id': devUserId };
  }

  throw new Error(
    'Нет ни Telegram WebApp initData, ни NEXT_PUBLIC_DEV_USER_ID — невозможно авторизоваться',
  );
}

/** Мягкая тактильная обратная связь — не бросает, если Telegram
 * недоступен (вне Telegram haptics физически не существует, это не
 * ошибка, а норма для DEV-режима в браузере). */
export function haptic(
  kind: 'success' | 'error' | 'warning' | 'light' | 'medium' | 'selection',
): void {
  const webApp = getTelegramWebApp();
  if (!webApp) return;

  switch (kind) {
    case 'success':
    case 'error':
    case 'warning':
      webApp.HapticFeedback.notificationOccurred(kind);
      break;
    case 'light':
    case 'medium':
      webApp.HapticFeedback.impactOccurred(kind);
      break;
    case 'selection':
      webApp.HapticFeedback.selectionChanged();
      break;
  }
}

/** Шаринг решения (§MVP-пункт 4, "шаринг решения") — через нативную
 * t.me/share-ссылку, не требует настройки inline-режима бота. Работает
 * и через Telegram.WebApp.openTelegramLink() (открывает выбор чата
 * внутри Telegram, не покидая приложение), и как обычная ссылка вне
 * Telegram (window.open) — деградирует по возможностям, но не по факту
 * работы: за пределами Telegram шаринг просто открывается в новой вкладке. */
export function shareViaTelegram(text: string, url?: string): void {
  const shareUrl = `https://t.me/share/url?${new URLSearchParams({
    ...(url ? { url } : {}),
    text,
  }).toString()}`;

  const webApp = getTelegramWebApp();
  if (webApp) {
    webApp.openTelegramLink(shareUrl);
  } else if (typeof window !== 'undefined') {
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
  }
}

