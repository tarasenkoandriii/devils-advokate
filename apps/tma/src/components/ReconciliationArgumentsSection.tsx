'use client';

// Пункт 49 (backend) → TMA UI: Reconciliation Arguments (§3.14 ТЗ).
// Уровень проекта — тот же паттерн секции, что OutcomeScenariosSection.
// "Используется как отдельная опция... наравне с обычными аргументами
// 'за' и 'против'" (буквально из ТЗ) — отдельная секция, не смешана с
// ArgumentsList.tsx (обычные PRO/CON).

import { useEffect, useState } from 'react';
import { generateReconciliationArguments, listReconciliationArguments } from '../lib/features';
import { ReconciliationArgument } from '../lib/types';
import { haptic } from '../lib/telegram';

interface ReconciliationArgumentsSectionProps {
  projectId: string;
}

export function ReconciliationArgumentsSection({ projectId }: ReconciliationArgumentsSectionProps) {
  const [args, setArgs] = useState<ReconciliationArgument[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReconciliationArguments(projectId)
      .then(setArgs)
      .catch(() => setArgs([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const created = await generateReconciliationArguments(projectId);
      setArgs((prev) => [...created, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      // §3.14 ТЗ: без указанного вероисповедания фича недоступна —
      // backend отвечает BadRequestException с понятным текстом,
      // здесь просто показываем его как есть, не переопределяем.
      setError(err instanceof Error ? err.message : 'Не удалось найти аргументы для примирения');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return null;

  return (
    <section className="reconciliation-arguments-section">
      <h3>Аргументы для примирения</h3>
      <p className="conversations-section__hint">
        Не для победы в споре — для снижения накала и примирения. Источник — религиозные первоисточники по вашей
        традиции, ссылка 🔵 (проверяемый первоисточник), применение к ситуации 🟡 (догадка ИИ).
      </p>

      {args.length > 0 && (
        <ul className="reconciliation-arguments-list">
          {args.map((a) => (
            <li key={a.id} className="reconciliation-arguments-list__item">
              {a.scriptureReference && <span className="reconciliation-arguments-list__reference">{a.scriptureReference}</span>}
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="generation-error">{error}</p>}
      <button type="button" onClick={handleGenerate} disabled={generating}>
        {generating ? 'Ищем…' : 'Показать аргументы для примирения'}
      </button>
    </section>
  );
}
