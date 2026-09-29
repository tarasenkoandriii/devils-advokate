'use client';

// Generic read-only вьюер для панелей kind=json/comparison-table —
// backend уже возвращает структурированные данные, здесь только
// аккуратный рендер: таблица для массива однородных объектов, дерево
// для остального. Не пытается «угадать» семантику.
//
// Пункт [machine-text] 2026-09-04. Этим вьюером нарисованы ЦЕЛЫЕ ВКЛАДКИ
// продукта («Сверка консультаций», «Проект соглашения», «История цели»,
// «Журнал доступа», «Флаги соответствия», …), а часть эндпоинтов отдаёт
// сырые строки Prisma — то есть человек читал ИМЕНА КОЛОНОК БАЗЫ
// (`goalDescription`, `occurredAt`, `action`), сырые перечисления
// (`DISCREPANCY_FOUND`), ISO-даты с миллисекундами, а вложенный массив
// попадал в ячейку через `JSON.stringify`, буквально с фигурными
// скобками. Подписи и форматы берутся из `lib/field-labels`, где собраны
// уже принятые проектом слова; НЕИЗВЕСТНОЕ ПОЛЕ ПОКАЗЫВАЕТСЯ КАК ЕСТЬ —
// придумать подпись полю, смысла которого никто не проверил, значит
// соврать увереннее, чем показать латиницу.
import { ReactNode, useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { fieldLabel, valueLabel, formatMoment, looksLikeIsoMoment } from '../../lib/field-labels';

/** Скалярное значение в человеческом виде. Объекты сюда не попадают —
 * их рисует `JsonView` рекурсивно; раньше здесь стоял `JSON.stringify`,
 * и вложенный массив уезжал на экран как есть. */
export function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return looksLikeIsoMoment(v) ? formatMoment(v) : valueLabel(v);
  return String(v);
}

/** Значение внутри ячейки или определения: скаляр — текстом, вложенное —
 * тем же вьюером, многострочный текст — с сохранением переносов.
 *
 * Многострочность отдельно: «Проект соглашения» возвращает готовый
 * документ с дисклеймером и переносами строк, а прежний рендер схлопывал
 * его в одну строку — предупреждение «это не юридически завершённый
 * документ» тонуло в дампе полей. */
function renderCell(v: unknown): ReactNode {
  if (v !== null && typeof v === 'object') return <JsonView data={v} />;
  if (typeof v === 'string' && v.includes('\n')) return <div className="domain-longtext">{v}</div>;
  return renderValue(v);
}

export function JsonView({ data }: { data: unknown }) {
  if (Array.isArray(data) && data.length > 0 && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const keys = Array.from(new Set(data.flatMap((x) => Object.keys(x as object)))).filter((k) => !/^(id|.*Id|createdAt|updatedAt)$/.test(k));
    return (
      <div className="domain-table-wrap">
        <table className="domain-table">
          <thead><tr>{keys.map((k) => <th key={k}>{fieldLabel(k)}</th>)}</tr></thead>
          <tbody>{data.map((row: any, i) => <tr key={row.id ?? i}>{keys.map((k) => <td key={k}>{renderCell(row[k])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return (
      <dl className="domain-dl">
        {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
          <div key={k}><dt>{fieldLabel(k)}</dt><dd>{renderCell(v)}</dd></div>
        ))}
      </dl>
    );
  }
  if (Array.isArray(data) && data.length === 0) return <p className="card-section__empty">Пока пусто.</p>;
  if (typeof data === 'string' && data.includes('\n')) return <div className="domain-longtext">{data}</div>;
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
      {error && <p role="alert" className="generation-error">{error}</p>}
      {data === undefined && !error && <p>Загрузка…</p>}
      {data !== undefined && <JsonView data={data} />}
    </div>
  );
}
