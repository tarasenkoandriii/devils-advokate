'use client';

// Пункт 79 (backend) → TMA UI: умные советы планировщика (пункт 58
// общего списка). Отдельный, изолированный компонент — синтез из
// личных фактов/связей/статусов, не привязан к конкретной
// запланированной встрече, поэтому смонтирован на уровне проекта, а
// не внутри отдельной карточки встречи.

import { useEffect, useState } from 'react';
import { generateSchedulerAdvice, listSchedulerAdvice } from '../lib/features';
import { ApiRequestError } from '../lib/api';
import { SchedulerAdvice } from '../lib/types';
import { haptic } from '../lib/telegram';

interface SchedulerAdviceSectionProps {
  projectId: string;
}

export function SchedulerAdviceSection({ projectId }: SchedulerAdviceSectionProps) {
  const [advice, setAdvice] = useState<SchedulerAdvice[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSchedulerAdvice(projectId)
      .then(setAdvice)
      .catch(() => setAdvice([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const created = await generateSchedulerAdvice(projectId);
      setAdvice(created);
      haptic('success');
    } catch (err) {
      haptic('error');
      if (err instanceof ApiRequestError && err.httpStatus === 400) {
        setError(err.message); // backend уже формулирует понятно: "добавьте личные факты или связи"
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось составить советы');
      }
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return null;

  return (
    <section className="scheduler-advice-section">
      <h3>Советы по планированию</h3>
      <p className="conversations-section__hint">
        На основе личных фактов о людях (строго со слов) и связей между ними — с кем встречаться отдельно, нужна ли
        пауза, какой формат уместнее.
      </p>

      {advice.length > 0 && (
        <ul className="scheduler-advice-section__list">
          {advice.map((a) => (
            <li key={a.id}>{a.adviceText}</li>
          ))}
        </ul>
      )}

      {error && <p className="generation-error">{error}</p>}
      <button type="button" onClick={handleGenerate} disabled={generating}>
        {generating ? 'Составляем…' : 'Составить советы'}
      </button>
    </section>
  );
}
