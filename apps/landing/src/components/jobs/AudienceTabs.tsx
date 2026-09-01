'use client';

// Пункт [job-landing] 2026-09-01 — переключатель аудитории. Состояние
// в URL-хэше (#candidates / #agencies), чтобы рекламная ссылка вела
// сразу на нужную половину (ТЗ §3). Progressive enhancement: обе
// секции всегда в DOM и без JS читаются последовательно — табы лишь
// скроллят и подсвечивают, ничего не скрывая (скрытие display:none
// сломало бы и без-JS чтение, и якорные ссылки).

import { useEffect, useState } from 'react';

export function AudienceTabs({ candidatesLabel, agenciesLabel }: { candidatesLabel: string; agenciesLabel: string }) {
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
    <div className="jobs-tabs" role="tablist" aria-label={`${candidatesLabel} / ${agenciesLabel}`}>
      <a
        href="#candidates"
        role="tab"
        aria-selected={active === 'candidates'}
        className={`jobs-tabs__tab${active === 'candidates' ? ' jobs-tabs__tab--active' : ''}`}
      >
        {candidatesLabel}
      </a>
      <a
        href="#agencies"
        role="tab"
        aria-selected={active === 'agencies'}
        className={`jobs-tabs__tab${active === 'agencies' ? ' jobs-tabs__tab--active' : ''}`}
      >
        {agenciesLabel}
      </a>
    </div>
  );
}
