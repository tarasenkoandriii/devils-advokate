'use client';

// Пункт 75 (backend) → TMA UI: лог изменений статуса проекта с
// цветовой индикацией (§3.39 ТЗ). Хронология конфликта наравне с
// хронологией аргументов — buкально ТЗ: "полезно перед подготовкой
// к следующему разговору, видно, в какую сторону идёт динамика".

import { useEffect, useState } from 'react';
import { getProjectLog } from '../lib/features';
import { ProjectLogEntry } from '../lib/types';

interface ProjectLogSectionProps {
  projectId: string;
}

export function ProjectLogSection({ projectId }: ProjectLogSectionProps) {
  const [entries, setEntries] = useState<ProjectLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjectLog(projectId)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || entries.length === 0) return null;

  return (
    <section className="project-log-section">
      <h3>Хронология конфликта</h3>
      <ul className="project-log-section__list">
        {entries.map((e, i) => (
          <li key={i} className={`project-log-section__item project-log-section__item--${e.color.toLowerCase()}`}>
            <span className="project-log-section__dot">{e.color === 'RED' ? '🔴' : '🟢'}</span>
            <span>{e.description}</span>
            <span className="conversations-section__hint">{new Date(e.occurredAt).toLocaleString('ru-RU')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
