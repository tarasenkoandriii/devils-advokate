'use client';

// Пункт 24 (backend) → TMA UI: Open Loops (§3.59 ТЗ).
//
// Краткая сводка, не отдельная страница — грузится автоматически при
// открытии проекта (как Evidence Gap/Stale Fact Alert — чистая
// агрегация, не AI-вызов, показать её ничего не стоит). Развёрнутые
// детали — по клику, чтобы не загромождать верх страницы проекта
// длинными списками по умолчанию.

import { useEffect, useState } from 'react';
import { getOpenLoopsSummary } from '../lib/features';
import { OpenLoopsSummary } from '../lib/types';

interface OpenLoopsSectionProps {
  projectId: string;
}

export function OpenLoopsSection({ projectId }: OpenLoopsSectionProps) {
  const [summary, setSummary] = useState<OpenLoopsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    getOpenLoopsSummary(projectId)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || !summary) return null;

  const total =
    summary.unansweredQuestionsCount +
    summary.openCommitmentsCount +
    summary.pendingDecisionsCount +
    summary.unresolvedObjectionsCount;

  if (total === 0) return null; // нечего показывать — не загромождаем страницу пустой сводкой

  return (
    <section className="open-loops-section">
      <div className="open-loops-section__summary" onClick={() => setExpanded((v) => !v)}>
        {summary.unansweredQuestionsCount > 0 && (
          <span>{summary.unansweredQuestionsCount} неотвеченных вопроса</span>
        )}
        {summary.openCommitmentsCount > 0 && <span>{summary.openCommitmentsCount} обязательства</span>}
        {summary.pendingDecisionsCount > 0 && <span>{summary.pendingDecisionsCount} решение в ожидании</span>}
        {summary.unresolvedObjectionsCount > 0 && (
          <span>{summary.unresolvedObjectionsCount} неразрешённое возражение</span>
        )}
      </div>

      {expanded && (
        <div className="open-loops-section__details">
          {summary.details.missingInformationQuestions.length > 0 && (
            <div>
              <p className="steelman-case__label">Вопросы (проверка полноты информации)</p>
              <ul>
                {summary.details.missingInformationQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.details.unresolvedConflictQuestions.length > 0 && (
            <div>
              <p className="steelman-case__label">Вопросы (конфликты фактов)</p>
              <ul>
                {summary.details.unresolvedConflictQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.details.openCommitments.length > 0 && (
            <div>
              <p className="steelman-case__label">Обязательства</p>
              <ul>
                {summary.details.openCommitments.map((c) => (
                  <li key={c.id}>{c.description}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.details.pendingDecisions.length > 0 && (
            <div>
              <p className="steelman-case__label">Решения в ожидании</p>
              <ul>
                {summary.details.pendingDecisions.map((a) => (
                  <li key={a.id}>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.details.unresolvedObjections.length > 0 && (
            <div>
              <p className="steelman-case__label">Неразрешённые возражения</p>
              <ul>
                {summary.details.unresolvedObjections.map((a) => (
                  <li key={a.id}>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
