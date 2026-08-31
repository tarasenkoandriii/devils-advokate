'use client';

// Generic read-only вьюер для панелей kind=json/comparison-table —
// backend уже возвращает структурированные данные, здесь только
// аккуратный рендер: таблица для массива однородных объектов, дерево
// для остального. Не пытается «угадать» семантику.
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';

export function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function JsonView({ data }: { data: unknown }) {
  if (Array.isArray(data) && data.length > 0 && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const keys = Array.from(new Set(data.flatMap((x) => Object.keys(x as object)))).filter((k) => !/^(id|.*Id|createdAt|updatedAt)$/.test(k));
    return (
      <div className="domain-table-wrap">
        <table className="domain-table">
          <thead><tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>{data.map((row: any, i) => <tr key={row.id ?? i}>{keys.map((k) => <td key={k}>{renderValue(row[k])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return (
      <dl className="domain-dl">
        {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{Array.isArray(v) || (v && typeof v === 'object') ? <JsonView data={v} /> : renderValue(v)}</dd></div>
        ))}
      </dl>
    );
  }
  if (Array.isArray(data) && data.length === 0) return <p className="card-section__empty">Пока пусто.</p>;
  return <pre className="domain-json">{renderValue(data)}</pre>;
}

export function JsonPanel({ route, title, refreshKey }: { route: string; title?: string; refreshKey?: unknown }) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    domainApi.getJson(route).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [route, refreshKey]);
  return (
    <div className="domain-panel">
      {title && <h3>{title}</h3>}
      {error && <p className="generation-error">{error}</p>}
      {data === undefined && !error && <p>Загрузка…</p>}
      {data !== undefined && <JsonView data={data} />}
    </div>
  );
}
