'use client';

// Пункт [job-landing] 2026-09-01 — переключатель аудитории. Состояние
// в URL-хэше (#candidates / #agencies), чтобы рекламная ссылка вела
// сразу на нужную половину (ТЗ §3). Progressive enhancement: обе
// секции всегда в DOM и без JS читаются последовательно — табы лишь
// скроллят и подсвечивают, ничего не скрывая (скрытие display:none
// сломало бы и без-JS чтение, и якорные ссылки).
//
// АУДИТ 2026-09-02: здесь стояли role="tablist"/role="tab"/aria-selected,
// и это ДЕЗИНФОРМИРОВАЛО. Паттерн вкладок обещает скринридеру, что
// панели переключаются и остальные скрыты, — а тут обычные якорные
// ссылки, которые ничего не скрывают (и правильно делают). Плюс до
// гидратации обе объявлялись невыбранными: «tablist без выбранной
// вкладки». Роли убраны, осталась навигация по секциям с aria-current —
// то, чем это и является. Визуальная подсветка не изменилась.

import { useEffect, useState } from 'react';

export function AudienceTabs({
  candidatesLabel,
  agenciesLabel,
  navLabel,
}: {
  candidatesLabel: string;
  agenciesLabel: string;
  navLabel: string;
}) {
  const [active, setActive] = useState<'candidates' | 'agencies' | null>(null);

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace('#', '');
      setActive(h === 'agencies' ? 'agencies' : h === 'candidates' ? 'candidates' : null);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  return (
    <nav className="jobs-tabs" aria-label={navLabel}>
      <a
        href="#candidates"
        aria-current={active === 'candidates' ? 'true' : undefined}
        className={`jobs-tabs__tab${active === 'candidates' ? ' jobs-tabs__tab--active' : ''}`}
      >
        {candidatesLabel}
      </a>
      <a
        href="#agencies"
        aria-current={active === 'agencies' ? 'true' : undefined}
        className={`jobs-tabs__tab${active === 'agencies' ? ' jobs-tabs__tab--active' : ''}`}
      >
        {agenciesLabel}
      </a>
    </nav>
  );
}
