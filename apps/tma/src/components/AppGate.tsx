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
import { getDisclaimerStatus } from '../lib/features';
import { LaunchDisclaimer } from './LaunchDisclaimer';

type GateState = 'loading' | 'blocked' | 'open' | 'error';

export function AppGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDisclaimerStatus()
      .then((status) => setState(status.acknowledged ? 'open' : 'blocked'))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Не удалось проверить статус приложения');
        setState('error');
      });
  }, []);

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
