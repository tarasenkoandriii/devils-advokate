'use client';

import { ReactNode, useState } from 'react';

export interface ModerationQueueTableProps<T extends { id: string }> {
  items: T[];
  columns: string[];
  renderCells: (item: T) => ReactNode;
  onAccept: (item: T) => Promise<void>;
  onReject: (item: T) => Promise<void>;
  acceptLabel?: string;
  rejectLabel?: string;
  emptyMessage?: string;
}

export function ModerationQueueTable<T extends { id: string }>({
  items,
  columns,
  renderCells,
  onAccept,
  onReject,
  acceptLabel = 'Принять',
  rejectLabel = 'Отклонить',
  emptyMessage = 'Очередь пуста — нечего модерировать.',
}: ModerationQueueTableProps<T>) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  async function handle(item: T, action: (item: T) => Promise<void>) {
    setPendingId(item.id);
    try {
      await action(item);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            {renderCells(item)}
            <td>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={pendingId === item.id}
                  onClick={() => handle(item, onAccept)}
                >
                  {acceptLabel}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={pendingId === item.id}
                  onClick={() => handle(item, onReject)}
                >
                  {rejectLabel}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
