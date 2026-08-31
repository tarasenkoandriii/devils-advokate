'use client';

import { useEffect, useState } from 'react';
import { listLibraryModerationQueue, moderateLibraryEntry } from '../../../lib/endpoints';
import { ModerationQueueTable } from '../../../components/ModerationQueueTable';
import type { LibraryEntry } from '../../../lib/types';

export default function LibraryModerationPage() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setEntries(await listLibraryModerationQueue());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить очередь');
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!entries) return <div className="page"><p className="muted">Загрузка…</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Модерация библиотеки</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Разборы, отправленные пользователями в публичную библиотеку (§3.5 ТЗ) — снапшот текста
        аргументов на момент отправки, не живая ссылка на проект.
      </p>
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
          await moderateLibraryEntry(entry.id, 'ACCEPT');
          setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? null);
        }}
        onReject={async (entry) => {
          await moderateLibraryEntry(entry.id, 'REJECT');
          setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? null);
        }}
      />
    </div>
  );
}
