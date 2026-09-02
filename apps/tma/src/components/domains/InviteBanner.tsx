'use client';

// Пункт [deep-links] 2026-09-02 — приглашение по ссылке доводится до
// конца, а не показывается формой «введите токен».
//
// Аудит нашёл разрыв: бэкенд выдавал ссылку-приглашение (команда
// рекрутинга, инвест-группа), но приложение параметр запуска не читало,
// и получатель попадал на главную. Даже добравшись до нужного экрана,
// он должен был вручную ВВЕСТИ токен из ссылки — при том что ссылку он
// уже открыл. Здесь ссылка доводит действие до конца одним нажатием.
import { useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { haptic } from '../../lib/telegram';

export function InviteBanner({
  token,
  route,
  title,
  actionLabel,
  onJoined,
}: {
  token: string;
  /** POST-маршрут вступления: `/recruiting-teams/:token/join` и т.п. */
  route: string;
  title: string;
  actionLabel: string;
  onJoined?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'done') {
    return <p className="card-section__empty">{title}: вы приняты. Обновите список ниже.</p>;
  }

  return (
    <div className="domain-panel">
      <p>{title}</p>
      {error && <p className="generation-error">{error}</p>}
      <button
        type="button"
        className="primary"
        disabled={state === 'busy'}
        onClick={async () => {
          setState('busy');
          setError(null);
          try {
            await domainApi.postJson(route, { token });
            haptic('success');
            setState('done');
            onJoined?.();
          } catch (e) {
            haptic('error');
            setError(e instanceof Error ? e.message : 'Не удалось принять приглашение');
            setState('idle');
          }
        }}
      >
        {state === 'busy' ? 'Принимаем…' : actionLabel}
      </button>
    </div>
  );
}
