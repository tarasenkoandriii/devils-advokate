'use client';

import { useEffect, useState } from 'react';
import { listLibraryModerationQueue, moderateLibraryEntry } from '../../../lib/endpoints';
import { ModerationQueueTable } from '../../../components/ModerationQueueTable';
import type { LibraryEntry } from '../../../lib/types';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { OperatorTraceNotice } from '../../../components/OperatorTraceNotice';
import { operatorScreenActions } from '../../../lib/operator-screens';

export default function LibraryModerationPage() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  // Пункт [decision-basis] 2026-09-04 — две разные беды, два разных
  // сообщения. Не загрузилась очередь — показывать нечего, ранний
  // возврат честен. Не удалось принять или отклонить ОДНУ запись —
  // очередь на экране осталась верной, и уносить её вместе с сообщением
  // значит отнять у оператора единственный способ проверить, применилось
  // решение или нет.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    try {
      setEntries(await listLibraryModerationQueue());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить очередь');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loadError) return <div className="page"><p role="alert" style={{ color: 'var(--signal-critical)' }}>{loadError}</p></div>;
  if (!entries) return <div className="page"><p className="muted">Загрузка…</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Модерация библиотеки</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Разборы, отправленные пользователями в публичную библиотеку (§3.5 ТЗ) — снапшот текста
        аргументов на момент отправки, не живая ссылка на проект.
      </p>
      {/* Пункт [operator-left-a-trace-unsaid] 2026-09-25: что останется
          после решения и увидит ли это человек — одним правилом на все
          экраны оператора, а не подписью, написанной здесь руками. */}
      <OperatorTraceNotice actions={operatorScreenActions('app/moderation/library/page.tsx')} />
      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />
      <ModerationQueueTable
        items={entries}
        columns={['Название', 'Категория', 'Аргументы']}
        renderCells={(entry) => (
          <>
            <td>{entry.title}</td>
            <td>{entry.category}</td>
            <td>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {entry.arguments.map((a) => (
                  <li key={a.id} style={{ marginBottom: 4 }}>
                    <span className={`badge ${a.stance === 'PRO' ? 'badge-ok' : 'badge-bad'}`}>{a.stance}</span>{' '}
                    {a.text}
                  </li>
                ))}
              </ul>
            </td>
          </>
        )}
        onAccept={async (entry) => {
          // [project-audit] 2026-09-01: сбой модерации был молчаливым.
          try {
            await moderateLibraryEntry(entry.id, 'ACCEPT');
            setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? null);
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Не удалось принять запись — запись осталась в очереди');
          }
        }}
        onReject={async (entry) => {
          try {
            await moderateLibraryEntry(entry.id, 'REJECT');
            setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? null);
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Не удалось отклонить запись — запись осталась в очереди');
          }
        }}
      />
    </div>
  );
}
