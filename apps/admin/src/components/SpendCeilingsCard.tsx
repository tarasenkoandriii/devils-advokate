'use client';

// Пункт [the-lever-that-silently-did-nothing] 2026-09-30 — потолки
// расходов на ЭТОМ развёртывании.
//
// Отдельным компонентом НАРОЧНО: блок «Ручные миграции» живёт внутри
// страницы, и поэтому у него до сих пор нет теста — рисовать в проверке
// нечего. Этот блок рисуется.
//
// ГЛАВНОЕ РЕШЕНИЕ РАЗМЕТКИ — не число, а ПРИЧИНА рядом с ним. Три
// состояния выглядели одинаково («потолок 300»), и худшее из них —
// «переменная задана, значение не прочиталось»: рычаг кажется нажатым.
// Поэтому оно выделено, названо словами и показывает, ЧТО оператор
// написал, а не только что это не подошло.

import type { SpendCeilingsState, SpendCeilingRow } from '../lib/types';

function sourceLabel(row: SpendCeilingRow): string {
  switch (row.source) {
    case 'окружение':
      return `из ${row.env}`;
    case 'умолчание: переменная не задана':
      return `умолчание кода; ${row.env} не задана`;
    case 'умолчание: значение не прочитано':
      return `НЕ ПРОЧИТАНО: в ${row.env} стои́т «${row.raw}» — работает умолчание ${row.fallback}`;
    case 'зашито в коде':
      return 'зашито в коде — не подкрутить, не тронув код';
  }
}

export function SpendCeilingsCard({ state }: { state: SpendCeilingsState }) {
  const broken = state.rows.filter((r) => r.source === 'умолчание: значение не прочитано');
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h2 style={{ marginTop: 0 }}>Потолки расходов на этом развёртывании</h2>

      {broken.length > 0 && (
        <p className="warn" role="status">
          Настроено с ошибкой: {broken.length}. Переменная задана, но значение не прочиталось — продукт работает на
          умолчании, то есть рычаг нажат не был. Это не то же самое, что «потолок не выставляли».
        </p>
      )}
      {state.off > 0 && (
        <p className="warn" role="status">
          Снято совсем потолков: {state.off}. Ноль означает «без потолка», а не «нулевой потолок».
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Что ограничено</th>
            <th>Действует</th>
            <th>Откуда</th>
            <th>За что платим</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((r) => (
            <tr key={r.what}>
              <td>{r.what}</td>
              <td>{r.off ? 'без потолка' : `${r.value} ${r.unit}`}</td>
              <td className={r.source === 'умолчание: значение не прочитано' ? 'warn' : 'muted'}>{sourceLabel(r)}</td>
              <td className="muted">{r.costs}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Чего блок не знает — на экране, а не только в комментарии:
          оператор читает экран, а не исходник. */}
      <ul className="muted">
        {state.doesNotKnow.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
