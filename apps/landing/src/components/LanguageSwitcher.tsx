'use client';

// Выпадающий список с флагами — тот же паттерн, что в остальных
// лендингах стека, вместо прежних инлайн-ссылок текстом. Клиентский
// компонент (нужен open/closed state + клик вне/Escape для закрытия) —
// использующие его Hero/Footer остаются серверными компонентами,
// Next.js App Router сам расставляет границу клиент/сервер на уровне
// этого файла, не требует переводить родителя целиком в 'use client'.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { locales, localeNames, localeFlags, type Locale } from '../lib/i18n/config';

export function LanguageSwitcher({ current }: { current: Locale }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return (
    <div className="lang-dropdown" ref={containerRef}>
      <button
        type="button"
        className="lang-dropdown__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden="true">{localeFlags[current]}</span>
        <span className="lang-dropdown__code">{current.toUpperCase()}</span>
        <span className="lang-dropdown__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul className="lang-dropdown__menu" role="listbox">
          {locales.map((locale) => (
            <li key={locale} role="option" aria-selected={locale === current}>
              <Link
                href={`/${locale}`}
                hrefLang={locale}
                className={
                  locale === current
                    ? 'lang-dropdown__item lang-dropdown__item--active'
                    : 'lang-dropdown__item'
                }
                onClick={() => setOpen(false)}
              >
                <span aria-hidden="true">{localeFlags[locale]}</span>
                <span>{localeNames[locale]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
