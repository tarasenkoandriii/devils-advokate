'use client';

// Пункт [admin-panel]: одна навигация на всё приложение (ТЗ §3, «Одна
// навигация, три раздела» — по прямому решению объединить в одном
// приложении). Вкладки скрываются, не отключаются серым — по каждой
// свой флаг доступа (§4.1): «Библиотека» → isLibraryModerator,
// «Заведения» → isVenueModerator, «Пользователи»/«Промпты»/
// «Телеметрия» → isOperator (операционное управление проектом, не
// модерация контента — тот же принцип "разные домены ответственности").

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from '../lib/admin-auth-context';

interface NavItem {
  href: string;
  label: string;
  visible: boolean;
}

export function AdminNav() {
  const { me, logout } = useAdminAuth();
  const pathname = usePathname();

  if (!me) return null;

  const items: NavItem[] = [
    { href: '/moderation/library', label: 'Библиотека', visible: me.isLibraryModerator },
    { href: '/moderation/venues', label: 'Заведения', visible: me.isVenueModerator },
    { href: '/moderation/users', label: 'Пользователи', visible: me.isOperator },
    { href: '/prompts', label: 'Промпты', visible: me.isOperator },
    { href: '/telemetry', label: 'Телеметрия', visible: me.isOperator },
    { href: '/calibration', label: 'Калибровка', visible: me.isOperator },
    { href: '/domains', label: 'Сценарии', visible: me.isOperator },
    { href: '/intake', label: 'Intake', visible: me.isOperator },
    { href: '/media-review', label: 'Медиа', visible: me.isOperator },
    // Пункт [admin-sandbox] 2026-08-31: прогон продовых сценариев
    // (цепочка YouTube-разбора) от имени самого оператора. isOperator,
    // а не отдельный флаг: песочница тратит реальные деньги и квоты.
    { href: '/sandbox', label: 'Sandbox', visible: me.isOperator },
  ];

  const visibleItems = items.filter((i) => i.visible);

  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 20px',
        height: 52,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span style={{ fontWeight: 600, marginRight: 24, letterSpacing: '0.01em' }}>Devil&apos;s Advocate — admin</span>

      {visibleItems.length === 0 && (
        <span className="muted" style={{ fontSize: 13 }}>
          Нет доступных вкладок — обратитесь к тому, кто управляет деплойментом, за нужным флагом доступа
        </span>
      )}

      {visibleItems.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              color: active ? 'var(--text)' : 'var(--text-muted)',
              background: active ? 'var(--bg-card)' : 'transparent',
              textDecoration: 'none',
            }}
          >
            {item.label}
          </Link>
        );
      })}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {me.userId}
        </span>
        <button className="btn" onClick={() => logout()}>
          Выйти
        </button>
      </div>
    </nav>
  );
}
