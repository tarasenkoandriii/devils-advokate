'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminAuth } from '../lib/admin-auth-context';

export default function RootPage() {
  const { me, loading } = useAdminAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || !me) return;
    if (me.isLibraryModerator) router.replace('/moderation/library');
    else if (me.isVenueModerator) router.replace('/moderation/venues');
    else if (me.isOperator) router.replace('/moderation/users');
  }, [loading, me, router]);

  if (loading) return <div className="page"><p className="muted">Загрузка…</p></div>;

  // Честное «нет доступа», не ошибка входа — acceptance-тест §5.1
  // (devils-advocate-admin-panel-tz.md): вход успешен, но ни одна
  // вкладка не видна, если ни один флаг доступа не выставлен.
  if (me && !me.isLibraryModerator && !me.isVenueModerator && !me.isOperator) {
    return (
      <div className="page" style={{ textAlign: 'center', paddingTop: 80 }}>
        <p className="muted">
          Вход выполнен, но у вашего аккаунта нет ни одного флага доступа. Обратитесь к тому, кто
          управляет деплойментом — доступ к вкладкам включается вручную в БД, регистрационной формы
          «стать оператором/модератором» в проекте нет.
        </p>
      </div>
    );
  }

  return null;
}
