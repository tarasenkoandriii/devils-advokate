'use client';

// Пункт 17 (backend) → TMA UI: Evidence Gap (§3.52 ТЗ).
//
// Показывает разбивку уже существующих аргументов проекта по 6
// категориям (Известно/Подкреплено/Предполагается/Неизвестно/
// Противоречиво/Устарело) — не отдельная форма ввода, чистое
// отображение уже посчитанного на бэкенде. Загружается сразу при
// открытии страницы (GET, не требует действия пользователя, в
// отличие от Missing Information/Turning Points — здесь нет AI-вызова,
// показать актуальную классификацию ничего не стоит).

import { useEffect, useState } from 'react';
import { getEvidenceGap } from '../lib/features';
import { EvidenceGapCategory, EvidenceGapReport } from '../lib/types';

interface EvidenceGapSectionProps {
  projectId: string;
}

const CATEGORY_LABELS: Record<EvidenceGapCategory, string> = {
  KNOWN: '🔵 Известно',
  SUPPORTED: '🟢 Подкреплено',
  ASSUMED: '🟡 Предполагается',
  UNKNOWN: '⚪ Неизвестно',
  CONTRADICTORY: '🔴 Противоречиво',
  STALE: '🕓 Устарело',
};

const CATEGORY_ORDER: EvidenceGapCategory[] = ['KNOWN', 'SUPPORTED', 'ASSUMED', 'CONTRADICTORY', 'STALE', 'UNKNOWN'];

export function EvidenceGapSection({ projectId }: EvidenceGapSectionProps) {
  const [report, setReport] = useState<EvidenceGapReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getEvidenceGap(projectId)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || !report) return null;

  const totalArguments = CATEGORY_ORDER.reduce((sum, cat) => sum + report.breakdown[cat].length, 0);
  if (totalArguments === 0) return null; // нет аргументов — нечего классифицировать

  return (
    <section className="evidence-gap-section">
      <h3>На чём основаны аргументы</h3>
      <p className="conversations-section__hint">{report.promptToUser}</p>

      <div className="evidence-gap-section__categories">
        {CATEGORY_ORDER.map((cat) => {
          const items = report.breakdown[cat];
          if (items.length === 0) return null;
          return (
            <div key={cat} className="evidence-gap-category">
              <span className="evidence-gap-category__label">
                {CATEGORY_LABELS[cat]} ({items.length})
              </span>
              <ul className="evidence-gap-category__list">
                {items.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
