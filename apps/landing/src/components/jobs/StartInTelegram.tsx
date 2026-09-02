'use client';

// Пункт [job-landing-attribution] 2026-09-02 — ТЗ §4: «UTM-метки
// прокидываются в deep-link как есть».
//
// Было: не прокидывались вовсе — страница серверная, а telegramStartUrl
// про адресную строку ничего не знал. Рекламный трафик терял метку
// ровно на границе лендинг → бот, и вопрос «какая кампания привела
// пользователя» оставался без ответа при живой рекламе.
//
// Прогрессивное улучшение, а не зависимость: ссылка рендерится на
// сервере уже рабочей (`jobs_landing`), а метка кампании дописывается
// на клиенте, если она есть в адресе. Без JS кнопка ведёт туда же,
// просто без источника — ТЗ §3 требует именно такого поведения.
//
// Почему только utm_source: параметр запуска Telegram — 64 символа
// [A-Za-z0-9_-]. Пять utm-полей туда не влезут даже в сокращении, а
// обрезанная метка хуже отсутствующей: выглядит как данные и считает
// не то. Остальные метки — задача веб-аналитики лендинга, где они и
// живут целиком.
import { useEffect, useState } from 'react';
import { telegramStartUrl } from '../../lib/telegram-url';

export function StartInTelegram({
  start,
  className = 'button button--primary',
  children,
  ariaLabel,
}: {
  start: 'jobs_landing' | 'recruiting_landing';
  className?: string;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const [href, setHref] = useState(() => telegramStartUrl(start));

  useEffect(() => {
    const utm = new URLSearchParams(window.location.search).get('utm_source');
    if (utm) setHref(telegramStartUrl(start, utm));
  }, [start]);

  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel}>
      {children}
    </a>
  );
}
