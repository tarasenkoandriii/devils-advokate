'use client';

// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §2): Telegram
// Login Widget — официальный виджет Telegram для обычных веб-сайтов
// (не Mini App). window.onTelegramAuth — callback, который сам виджет
// вызывает после успешного входа пользователя, с подписанным payload
// (data-onauth атрибут ниже ссылается на это же имя).
//
// АУДИТ: намеренно НЕ используется next/script здесь. telegram-widget.js
// вставляет саму кнопку логина ОТНОСИТЕЛЬНО позиции своего собственного
// <script>-тега в DOM (классический паттерн сторонних виджетов, идущий
// ещё с document.currentScript) — но next/script со strategy
// "afterInteractive"/"lazyOnload" документированно (подтверждено
// сообществом, не предположение) переносит сам script-тег в конец
// <body>, не оставляет его в месте JSX-дерева. Итог — кнопка виджета
// вставлялась бы в конец страницы, а не внутрь этой карточки логина.
// Обход — создать сам <script> вручную через DOM API и добавить его
// child-узлом внутрь ref'нутого контейнера — гарантирует точную
// позицию независимо от внутренней оптимизации next/script.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { devLogin, telegramCallback, TelegramLoginWidgetPayload } from '../../lib/endpoints';
import { ApiRequestError } from '../../lib/admin-api';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

// Docker dev-запуск (DOCKER.md): показывать кнопку локального входа или
// нет. Сравнение со строкой, а не Boolean(...) — NEXT_PUBLIC_*
// подставляются в бандл как строки, и "false" — истинная строка;
// Boolean('false') === true молча включил бы кнопку в проде.
// Это ТОЛЬКО про видимость кнопки: реальный запрет живёт на бэкенде
// (404 при ALLOW_DEV_AUTH!=true / NODE_ENV=production), UI-флаг сам по
// себе ничего не открывает.
const ALLOW_DEV_AUTH = process.env.NEXT_PUBLIC_ALLOW_DEV_AUTH === 'true';
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '123';

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramLoginWidgetPayload) => void;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Docker dev-запуск (DOCKER.md): та же обработка ответа, что и у
  // виджета, — общий setSubmitting/setError/replace, чтобы два входа не
  // разъезжались по поведению при ошибке.
  const handleDevLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await devLogin(DEV_USER_ID);
      router.replace('/moderation/library');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? `${err.message} (dev-вход включается переменной ALLOW_DEV_AUTH=true на стороне apps/api)`
          : 'Не удалось войти',
      );
      setSubmitting(false);
    }
  };

  useEffect(() => {
    window.onTelegramAuth = async (payload: TelegramLoginWidgetPayload) => {
      setSubmitting(true);
      setError(null);
      try {
        await telegramCallback(payload);
        router.replace('/moderation/library');
      } catch (err) {
        // Аутентификация сама по себе не требует прав (acceptance-тест
        // §5.1) — 401 здесь означает только испорченную/просроченную
        // подпись Telegram, не отсутствие прав доступа.
        setError(err instanceof ApiRequestError ? err.message : 'Не удалось войти');
        setSubmitting(false);
      }
    };
    return () => {
      window.onTelegramAuth = undefined;
    };
  }, [router]);

  useEffect(() => {
    if (!BOT_USERNAME || !containerRef.current) return;
    const container = containerRef.current;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);

    return () => {
      // На случай повторного монтирования (React StrictMode в dev
      // монтирует эффекты дважды) — контейнер очищается перед повторной
      // вставкой, чтобы не получить два виджета друг под другом.
      container.innerHTML = '';
    };
  }, []);

  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 120 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>Вход в админ-панель</h1>
        <p className="muted" style={{ marginBottom: 24, fontSize: 13 }}>
          Вход через Telegram не требует прав доступа — какие вкладки будут видны, зависит от флагов
          вашего аккаунта.
        </p>

        {!BOT_USERNAME && !ALLOW_DEV_AUTH && (
          <p style={{ color: 'var(--signal-critical)', fontSize: 13 }}>
            NEXT_PUBLIC_TELEGRAM_BOT_USERNAME не задан в окружении — виджет не может отобразиться.
          </p>
        )}

        {BOT_USERNAME && (
          <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center', minHeight: 40 }} />
        )}

        {ALLOW_DEV_AUTH && (
          <div style={{ marginTop: BOT_USERNAME ? 20 : 0 }}>
            {BOT_USERNAME && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                — или —
              </div>
            )}
            <button type="button" onClick={handleDevLogin} disabled={submitting} style={{ width: '100%' }}>
              Войти как dev-{DEV_USER_ID} (локальный стенд)
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
              Telegram Login Widget не работает на localhost (домен виджета задаётся боту через
              /setdomain, localhost туда не принимается) — поэтому в докер-стенде вход только такой.
              Пользователь получает все три флага доступа: оператор, модератор библиотеки, модератор
              заведений. Тот же аккаунт, что и <code>X-Dev-User-Id: {DEV_USER_ID}</code> в TMA.
            </p>
          </div>
        )}

        {submitting && <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>Входим…</p>}
        {error && (
          <p style={{ color: 'var(--signal-critical)', marginTop: 16, fontSize: 13 }}>{error}</p>
        )}
      </div>
    </div>
  );
}
