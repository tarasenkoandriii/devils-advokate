'use client';

import { useEffect, useState, Fragment } from 'react';
import { listUsers, restrictUser, blockUser, getUserDetail } from '../../../lib/endpoints';
import type { AdminUserRow, AdminUserDetail } from '../../../lib/types';

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [blockNoteDrafts, setBlockNoteDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, AdminUserDetail | 'loading' | undefined>>({});

  async function toggleDetail(user: AdminUserRow) {
    if (expanded[user.id]) {
      setExpanded((prev) => ({ ...prev, [user.id]: undefined }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [user.id]: 'loading' }));
    const detail = await getUserDetail(user.id);
    setExpanded((prev) => ({ ...prev, [user.id]: detail }));
  }

  async function load() {
    try {
      setUsers(await listUsers(search || undefined, restrictedOnly ? true : undefined, blockedOnly ? true : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить пользователей');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleRestrict(user: AdminUserRow) {
    const note = noteDrafts[user.id];
    const updated = await restrictUser(user.id, !user.isRestricted, user.isRestricted ? undefined : note);
    setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, isRestricted: updated.isRestricted } : u)) ?? null);
  }

  async function toggleBlock(user: AdminUserRow) {
    const note = blockNoteDrafts[user.id];
    const updated = await blockUser(user.id, !user.isBlocked, user.isBlocked ? undefined : note);
    setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, isBlocked: updated.isBlocked } : u)) ?? null);
  }

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Пользователи</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Два независимых уровня ограничения (§8 юридического чек-листа, п.11; Пункт
        [full-block]). «Ограничить» — блокирует девять конкретных действий (создание проекта,
        публикация в библиотеку, заявка заведения), пользователь по-прежнему может входить и
        читать данные. «Заблокировать» — отклоняет вход целиком, включая отдельный вход в эту
        же админку, если у пользователя есть права оператора.
      </p>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <input
          placeholder="Поиск по Telegram ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={restrictedOnly} onChange={(e) => setRestrictedOnly(e.target.checked)} />
          Только ограниченные
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} />
          Только заблокированные
        </label>
        <button className="btn" onClick={load}>
          Обновить
        </button>
      </div>

      {!users && <p className="muted">Загрузка…</p>}
      {users && users.length === 0 && <p className="muted">Никого не найдено.</p>}

      {users && users.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Telegram ID</th>
              <th>Флаги</th>
              <th>С нами с</th>
              <th>Статус</th>
              <th>Причина ограничения</th>
              <th>Действие</th>
              <th>Блокировка</th>
              <th>Причина блокировки</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Fragment key={u.id}>
                <tr key={u.id}>
                  <td>
                    <button
                      className="btn"
                      style={{ padding: '2px 8px', fontSize: 12 }}
                      onClick={() => toggleDetail(u)}
                    >
                      {u.telegramId}
                    </button>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {u.isLibraryModerator && <span className="badge badge-ok">Библиотека</span>}
                      {u.isVenueModerator && <span className="badge badge-ok">Заведения</span>}
                      {u.isOperator && <span className="badge badge-ok">Оператор</span>}
                      {!u.isLibraryModerator && !u.isVenueModerator && !u.isOperator && (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString('ru-RU')}</td>
                  <td>
                    <span className={u.isRestricted ? 'badge badge-bad' : 'badge badge-ok'}>
                      {u.isRestricted ? 'Ограничен' : 'Обычный'}
                    </span>
                  </td>
                  <td>
                    {!u.isRestricted && (
                      <input
                        placeholder="причина, если будете ограничивать"
                        style={{ width: '100%' }}
                        value={noteDrafts[u.id] ?? ''}
                        onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))}
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className={u.isRestricted ? 'btn btn-primary' : 'btn btn-danger'}
                      onClick={() => toggleRestrict(u)}
                    >
                      {u.isRestricted ? 'Снять ограничение' : 'Ограничить'}
                    </button>
                  </td>
                  <td>
                    <span className={u.isBlocked ? 'badge badge-bad' : 'badge badge-ok'}>
                      {u.isBlocked ? 'Заблокирован' : 'Обычный'}
                    </span>
                  </td>
                  <td>
                    {!u.isBlocked && (
                      <input
                        placeholder="причина, если будете блокировать"
                        style={{ width: '100%' }}
                        value={blockNoteDrafts[u.id] ?? ''}
                        onChange={(e) => setBlockNoteDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))}
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className={u.isBlocked ? 'btn btn-primary' : 'btn btn-danger'}
                      onClick={() => toggleBlock(u)}
                    >
                      {u.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                    </button>
                  </td>
                </tr>
                {expanded[u.id] && (
                  <tr key={`${u.id}-detail`}>
                    <td colSpan={9} style={{ background: 'var(--bg-elevated)' }}>
                      {expanded[u.id] === 'loading' ? (
                        <span className="muted">Загрузка деталей…</span>
                      ) : (
                        (() => {
                          const d = expanded[u.id] as AdminUserDetail;
                          return (
                            <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
                              <span>Проектов: {d.projectCount}</span>
                              <span>Разговоров: {d.conversationCount}</span>
                              <span>
                                Последняя активность:{' '}
                                {d.lastActivityAt ? new Date(d.lastActivityAt).toLocaleString('ru-RU') : '—'}
                              </span>
                              {d.restrictedNote && <span>Причина ограничения: {d.restrictedNote}</span>}
                              {d.blockedNote && <span>Причина блокировки: {d.blockedNote}</span>}
                            </div>
                          );
                        })()
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
