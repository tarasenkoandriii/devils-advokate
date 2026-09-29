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
import { isPublicRoute } from '../lib/public-routes';

type GateState = 'loading' | 'blocked' | 'open' | 'error';

/** Некриптографический отпечаток (djb2) — только чтобы различать
 *  параметры запуска в пределах одного сеанса, не для защиты. */
function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** Тело проверки дисклеймера — отдельной функцией, а не телом эффекта.
 *
 * Причина в проверяемости, и она честная. Эффект в статическом рендере
 * не запускается, поэтому мутация «убрать пропуск публичных страниц из
 * эффекта» не ловилась ничем: страница всё равно рисовалась коротким
 * замыканием ниже. А пропуск здесь не украшение — вне Telegram
 * `getAuthHeaders()` бросает СИНХРОННО, то есть без этой строки на
 * каждой публичной странице в эффекте возникала бы необработанная
 * ошибка. Функцию можно вызвать в проверке напрямую.
 *
 * @param publicPage страница открыта без Telegram по построению
 */
export async function checkDisclaimer(
  publicPage: boolean,
  setState: (s: GateState) => void,
  setError: (e: string) => void,
  fetchStatus: () => Promise<{ acknowledged: boolean }> = getDisclaimerStatus,
): Promise<void> {
  if (publicPage) return;
  try {
    const status = await fetchStatus();
    setState(status.acknowledged ? 'open' : 'blocked');
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Не удалось проверить статус приложения');
    setState('error');
  }
}

export function AppGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  // Пункт [gate-locked-the-public-door] 2026-09-26. Решение принимается
  // ДО любого состояния и до любого запроса: публичная страница не
  // должна ни ждать проверки, ни зависеть от того, чем эта проверка
  // кончилась. Вне Telegram `getAuthHeaders()` не возвращает 401, а
  // БРОСАЕТ — шлюз уходил в `error` и рисовал «Не удалось загрузить
  // приложение» вместо страницы, ради которой человеку прислали ссылку.
  const publicPage = isPublicRoute(pathname ?? '/');

  useEffect(() => {
    void checkDisclaimer(publicPage, setState, setError);
  }, [publicPage]);

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
    // Аудит 2026-09-02: в ключе — не сам параметр (для приглашений это
    // действующий токен), а его короткий отпечаток. sessionStorage
    // ограничен вкладкой и origin, но секрет в имени ключа читается любым
    // расширением с доступом к странице — незачем.
    const key = `start-param-handled:${fingerprint(attribution.raw)}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Приватный режим/запрет хранилища: переходим один раз за
      // монтирование — хуже, чем отметка, но лучше, чем не перейти.
    }
    router.replace(target);
  }, [state, pathname, router]);

  // Публичная страница рисуется сразу и целиком. Дисклеймер ей не
  // показывается намеренно: он — условие пользования приложением, а
  // пришедший по ссылке им не пользуется (см. `lib/public-routes.ts`).
  if (publicPage) return <>{children}</>;

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
