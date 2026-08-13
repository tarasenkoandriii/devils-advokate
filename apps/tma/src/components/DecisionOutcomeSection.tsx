'use client';

// Пункт 53 (TMA UI): запись исхода решения на странице проекта —
// половина Decision Track Record (§3.2 ТЗ), вторая половина —
// /calibration (агрегированный вид по всем проектам).

import { useEffect, useState } from 'react';
import { getDecisionOutcome, recordDecisionOutcome } from '../lib/features';
import { DecisionOutcome, DecisionOutcomeRating } from '../lib/types';
import { haptic } from '../lib/telegram';

interface DecisionOutcomeSectionProps {
  projectId: string;
}

const OUTCOME_OPTIONS: { value: DecisionOutcomeRating; label: string }[] = [
  { value: 'WENT_WELL', label: 'Прошло хорошо' },
  { value: 'WENT_POORLY', label: 'Прошло плохо' },
  { value: 'MIXED', label: 'Смешанно' },
  { value: 'TOO_EARLY_TO_TELL', label: 'Пока рано судить' },
];

export function DecisionOutcomeSection({ projectId }: DecisionOutcomeSectionProps) {
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState<DecisionOutcomeRating>('WENT_WELL');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDecisionOutcome(projectId)
      .then((o) => {
        setOutcome(o);
        if (o) {
          setRating(o.actualOutcome);
          setNotes(o.outcomeNotes ?? '');
          setCategory(o.category ?? '');
        }
      })
      .catch(() => setOutcome(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await recordDecisionOutcome(projectId, {
        actualOutcome: rating,
        outcomeNotes: notes || undefined,
        category: category || undefined,
      });
      setOutcome(saved);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить исход');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <section className="decision-outcome-section">
      <h3>Исход решения</h3>
      <p className="conversations-section__hint">
        Отметьте, что реально произошло — это накапливается в общую калибровку (страница «Калибровка решений»),
        не влияет на сам проект.
      </p>

      <div className="conversations-section__add">
        <label>
          Что произошло
          <select value={rating} onChange={(e) => setRating(e.target.value as DecisionOutcomeRating)}>
            {OUTCOME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Категория (необязательно)
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Например: карьера" />
        </label>
        <label>
          Заметки (необязательно)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Что конкретно произошло" />
        </label>
        {error && <p className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохраняем…' : outcome ? 'Обновить исход' : 'Сохранить исход'}
          </button>
        </div>
      </div>
    </section>
  );
}
