'use client';

// Пункт 75 (backend) → TMA UI: лог изменений статуса проекта с
// цветовой индикацией (§3.39 ТЗ). Хронология конфликта наравне с
// хронологией аргументов — buкально ТЗ: "полезно перед подготовкой
// к следующему разговору, видно, в какую сторону идёт динамика".
//
// Пункт [project-log-v2] — «в какую сторону» стало читаться в обе
// стороны: добавлены записи о спаде накала и о снятии флага, и снять
// флаг можно прямо отсюда. Снятие — действие ЧЕЛОВЕКА: система своих
// флагов не отменяет и о снятых не спорит.

import { useEffect, useState } from 'react';
import { getProjectLog, setProjectLogFlagDisputed } from '../lib/features';
import { ProjectLogEntry } from '../lib/types';
import { SectionLoadError } from './SectionLoadError';

interface ProjectLogSectionProps {
  projectId: string;
}

export function ProjectLogSection({ projectId }: ProjectLogSectionProps) {
  const [entries, setEntries] = useState<ProjectLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySignalId, setBusySignalId] = useState<string | null>(null);
  // Аудит 2026-09-03: раньше сбой загрузки давал пустой массив, а пустой
  // лог не рисуется вовсе — то есть недоступный сервер выглядел как
  // «конфликт не развивался». Для хронологии конфликта это худшая из
  // возможных подмен: молчание тут читается как спокойствие.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getProjectLog(projectId)
      .then((rows) => { setEntries(rows); setFailed(false); })
      .catch(() => { setEntries([]); setFailed(true); })
      .finally(() => setLoading(false));
  }, [projectId]);

  async function toggleFlag(signalId: string, disputed: boolean) {
    setBusySignalId(signalId);
    try {
      await setProjectLogFlagDisputed(projectId, signalId, disputed);
      setEntries(await getProjectLog(projectId));
    } catch {
      // Тихий сбой: лог остаётся тем, что реально лежит на сервере, а не
      // тем, что мы дорисовали бы локально.
    } finally {
      setBusySignalId(null);
    }
  }

  if (loading) return null;
  if (failed) return <SectionLoadError what="хронологию конфликта" hint="в проекте ничего не происходило" />;
  if (entries.length === 0) return null;

  // Флаг, у которого уже есть запись о снятии, второй раз снимать
  // нечего — у такой пары кнопка предлагает вернуть его обратно.
  const withdrawnSignalIds = new Set(
    entries.filter((e) => e.eventType === 'FLAG_WITHDRAWN' && e.sourceSignalId).map((e) => e.sourceSignalId as string),
  );

  return (
    <section className="project-log-section">
      <h3>Хронология конфликта</h3>
      <ul className="project-log-section__list">
        {entries.map((e, i) => {
          const isFlagAppearance = e.eventType === 'DISCREPANCY_DETECTED' || e.eventType === 'MANIPULATION_DETECTED';
          const withdrawn = !!e.sourceSignalId && withdrawnSignalIds.has(e.sourceSignalId);
          return (
            <li key={i} className={`project-log-section__item project-log-section__item--${e.color.toLowerCase()}`}>
              <span className="project-log-section__dot">{e.color === 'RED' ? '🔴' : '🟢'}</span>
              <span>{e.description}</span>
              <span className="conversations-section__hint">{new Date(e.occurredAt).toLocaleString('ru-RU')}</span>
              {isFlagAppearance && e.sourceSignalId && (
                <button
                  type="button"
                  className="project-log-section__flag-action"
                  disabled={busySignalId === e.sourceSignalId}
                  onClick={() => toggleFlag(e.sourceSignalId as string, !withdrawn)}
                >
                  {withdrawn ? 'Вернуть флаг' : 'Снять флаг'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="conversations-section__hint">
        Записи появляются только там, где известен человек: если на экране сопровождения собеседник не выбран, рост
        и спад накала сюда не попадают. Снятый флаг не стирает запись о его появлении — это хронология, а не текущее
        состояние.
      </p>
    </section>
  );
}
