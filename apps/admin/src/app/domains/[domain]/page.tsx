'use client';

import { useEffect, useState, Fragment } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { listDomainProjects, getDomainProject, setDomainProjectFrozen } from '../../../lib/endpoints';
import type { DomainProjectRow, DomainProjectDetail } from '../../../lib/types';
import { OperatorTraceNotice } from '../../../components/OperatorTraceNotice';
import { operatorScreenActions } from '../../../lib/operator-screens';

export default function DomainProjectsAdminPage() {
  const { domain } = useParams<{ domain: string }>();
  const [rows, setRows] = useState<DomainProjectRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<'all' | 'with' | 'without'>('all');
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, DomainProjectDetail | 'loading' | undefined>>({});

  useEffect(() => {
    setRows(null);
    listDomainProjects(domain, filter === 'all' ? undefined : filter === 'with')
      .then((r) => { setRows(r.items); setTotal(r.total); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [domain, filter]);

  async function toggle(id: string) {
    if (expanded[id]) { setExpanded((p) => ({ ...p, [id]: undefined })); return; }
    setExpanded((p) => ({ ...p, [id]: 'loading' }));
    try { const d = await getDomainProject(domain, id); setExpanded((p) => ({ ...p, [id]: d })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить'); setExpanded((p) => ({ ...p, [id]: undefined })); }
  }

  async function toggleFreeze(r: DomainProjectRow) {
    const frozen = !r.frozenAt;
    if (frozen && !window.confirm('Заморозить проект? Пользователь сохранит просмотр, но не сможет ничего менять до разморозки. Действие пишется в журнал аудита.')) return;
    try {
      const u = await setDomainProjectFrozen(domain, r.id, frozen, frozen ? noteDrafts[r.id] : undefined);
      setRows((prev) => prev?.map((x) => (x.id === r.id ? { ...x, frozenAt: u.frozenAt } : x)) ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить'); }
  }

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  return (
    <div className="page">
      <p><Link href="/domains">← Сценарии</Link></p>
      <h1>{domain} · {total} проектов</h1>
      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 8 }}>
        {(['all', 'with', 'without'] as const).map((f) => (
          <button key={f} className={filter === f ? 'btn btn-primary' : 'btn'} onClick={() => setFilter(f)}>{f === 'all' ? 'Все' : f === 'with' ? 'С конфигом' : 'Без конфига (застряли в онбординге)'}</button>
        ))}
      </div>
      {/* Пункт [operator-left-a-trace-unsaid] 2026-09-25: одно правило на
          все экраны оператора. Фраза в карточке ниже осталась — она о
          КОНКРЕТНОМ моменте, рядом со словами человека; здесь же
          перечислено, что остаётся после каждого действия экрана. */}
      <OperatorTraceNotice actions={operatorScreenActions('app/domains/[domain]/page.tsx')} />
      {!rows && <p className="muted">Загрузка…</p>}
      {rows && (
        <table>
          {/* Пункт [operator-read-the-question] 2026-09-25: столбца
              «Вопрос» здесь больше нет — в нём стояли слова человека о
              его деле, для всех проектов домена сразу. Список нужен,
              чтобы отличать строки и видеть состояние; текст — в
              карточке, и её открытие записывается в журнал. */}
          <thead><tr><th>Проект</th><th>Владелец (tg)</th><th>Создан</th><th>Разговоров</th><th>Конфиг</th><th>Заморозка</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td><code title="идентификатор проекта">{r.id.slice(0, 8)}</code></td>
                  <td>{r.owner.telegramId}</td><td>{new Date(r.createdAt).toLocaleDateString('ru-RU')}</td>
                  <td>{r.conversations}</td>
                  <td>{r.config ? <span className="badge badge-ok">есть</span> : <span className="badge badge-pending">нет</span>}</td>
                  <td>
                    {r.frozenAt ? (
                      <><span className="badge badge-bad">заморожен</span> <button className="btn" onClick={() => toggleFreeze(r)}>Разморозить</button></>
                    ) : (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <input placeholder="причина (в аудит)" value={noteDrafts[r.id] ?? ''} onChange={(e) => setNoteDrafts({ ...noteDrafts, [r.id]: e.target.value })} style={{ width: 160 }} />
                        <button className="btn btn-danger" onClick={() => toggleFreeze(r)}>Заморозить</button>
                      </span>
                    )}
                  </td>
                  <td><button className="btn" onClick={() => toggle(r.id)}>{expanded[r.id] ? 'Скрыть' : 'Открыть'}</button></td>
                </tr>
                {expanded[r.id] && (
                  <tr><td colSpan={7}>
                    {expanded[r.id] === 'loading' ? <span className="muted">Загрузка…</span> : (
                      <>
                        {/* Пункт [operator-read-the-question] 2026-09-25:
                            оператор должен видеть, что он делает. Ниже —
                            слова человека о его деле; открытие карточки
                            записано в журнал действий. Сказать это здесь
                            дешевле, чем объяснять потом. */}
                        <p className="muted" style={{ marginTop: 0 }}>
                          Здесь слова человека о его деле. Открытие карточки записано в журнал действий — с вашим
                          идентификатором и временем.
                        </p>
                        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(expanded[r.id], null, 2)}</pre>
                      </>
                    )}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
