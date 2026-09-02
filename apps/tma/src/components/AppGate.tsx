'use client';

// Закрывает пробел, зафиксированный в предыдущем проходе (фича 13):
// раньше дисклеймер проверялся только внутри app/page.tsx, поэтому
// прямой заход на /projects, /projects/[id], /projects/[id]/card или
// /privacy (закладка, перезагрузка на под-странице, глубокая ссылка)
// технически обходил блокировку. Теперь проверка на уровне layout —
// оборачивает {children} ОДИН раз для всего дерева страниц, ни одна
// страница не может отрендериться, минуя эту проверку, потому что
// сами страницы физически рендерятся ВНУТРИ этого компонента, не
// параллельно с ним.
//
// Использует getDisclaimerStatus(), не полный bootstrap() — на
// главной странице (app/page.tsx) отдельно вызывается bootstrap() для
// своих целей (загрузка согласий, privacyProcessingMode); дублировать
// эту более тяжёлую логику здесь ради одного поля не нужно, специальный
// узкий эндпоинт для этого и существует.

import { ReactNode, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getDisclaimerStatus } from '../lib/features';
import { LaunchDisclaimer } from './LaunchDisclaimer';
import { currentStartAttribution, startParamRoute } from '../lib/start-param';

type GateState = 'loading' | 'blocked' | 'open' | 'error';

export function AppGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    getDisclaimerStatus()
      .then((status) => setState(status.acknowledged ? 'open' : 'blocked'))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Не удалось проверить статус приложения');
        setState('error');
      });
  }, []);

  // Пункт [deep-links] 2026-09-02: переход по параметру запуска.
  //
  // Бэкенд выдавал ссылки-приглашения (передача кандидата, инвайт в
  // команду, инвест-группа) и посадочные /jobs слали свою метку, но
  // приложение start_param не читало ВООБЩЕ — во всём монорепо не было
  // ни одного упоминания. Экран /candidate-shares/[token] был физически
  // недостижим: ссылка приводила человека на главную.
  //
  // Здесь, в AppGate, а не на главной: дисклеймер обязан пройти первым
  // (переход только при state === 'open'), и приглашение не должно
  // теряться от того, с какой страницы открылось приложение.
  //
  // ОДНОРАЗОВО (ревью 2026-09-02): start_param живёт весь сеанс Mini
  // App, и без отметки пользователь, пришедший по ссылке, не смог бы
  // вернуться на главный экран — любой переход на «/» снова уводил бы
  // его по параметру, включая уже принятое приглашение.
  useEffect(() => {
    if (state !== 'open' || pathname !== '/') return;
    const attribution = currentStartAttribution();
    const target = startParamRoute(attribution);
    if (!target || !attribution) return;
    const key = `start-param-handled:${attribution.raw}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Приватный режим/запрет хранилища: переходим один раз за
      // монтирование — хуже, чем отметка, но лучше, чем не перейти.
    }
    router.replace(target);
  }, [state, pathname, router]);

  if (state === 'loading') {
    return <main className="page page--loading">Загрузка…</main>;
  }

  if (state === 'error') {
    return (
      <main className="page page--error">
        <p>Не удалось загрузить приложение: {error}</p>
      </main>
    );
  }

  if (state === 'blocked') {
    return <LaunchDisclaimer onAcknowledged={() => setState('open')} />;
  }

  return <>{children}</>;
}
