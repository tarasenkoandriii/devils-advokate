'use client';

// MVP-фича 9: форма BATNA/WATNA — тот же паттерн, что
// DecisionObjectiveForm (фича 6): свёрнута по умолчанию, обычная
// HTML-кнопка сохранения.

import { useEffect, useState } from 'react';
import { getBoundaries, saveBoundaries } from '../lib/features';

interface NegotiationBoundariesFormProps {
  projectId: string;
}

export function NegotiationBoundariesForm({ projectId }: NegotiationBoundariesFormProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [idealOutcome, setIdealOutcome] = useState('');
  const [acceptableOutcome, setAcceptableOutcome] = useState('');
  const [batna, setBatna] = useState('');
  const [watna, setWatna] = useState('');
  const [walkAwayPoint, setWalkAwayPoint] = useState('');

  useEffect(() => {
    getBoundaries(projectId)
      .then((b) => {
        if (!b) return;
        setIdealOutcome(b.idealOutcome ?? '');
        setAcceptableOutcome(b.acceptableOutcome ?? '');
        setBatna(b.batna ?? '');
        setWatna(b.watna ?? '');
        setWalkAwayPoint(b.walkAwayPoint ?? '');
        if (b.batna || b.watna) setExpanded(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveBoundaries(projectId, {
        idealOutcome: idealOutcome || undefined,
        acceptableOutcome: acceptableOutcome || undefined,
        batna: batna || undefined,
        watna: watna || undefined,
        walkAwayPoint: walkAwayPoint || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  if (!expanded) {
    return (
      <button type="button" className="objective-toggle" onClick={() => setExpanded(true)}>
        + Добавить BATNA/WATNA
      </button>
    );
  }

  return (
    <div className="decision-objective-form">
      <h3>Альтернативы, если не договоримся</h3>
      <p className="decision-objective-form__hint">
        Помогает понять, стоит ли соглашаться на предложенные условия.
      </p>

      <label>
        Идеальный исход
        <input value={idealOutcome} onChange={(e) => setIdealOutcome(e.target.value)} />
      </label>
      <label>
        Приемлемый исход
        <input value={acceptableOutcome} onChange={(e) => setAcceptableOutcome(e.target.value)} />
      </label>
      <label>
        BATNA (лучшая альтернатива, если не договоримся)
        <input value={batna} onChange={(e) => setBatna(e.target.value)} />
      </label>
      <label>
        WATNA (худшая такая альтернатива)
        <input value={watna} onChange={(e) => setWatna(e.target.value)} />
      </label>
      <label>
        Точка выхода — после чего лучше отказаться, чем соглашаться
        <input value={walkAwayPoint} onChange={(e) => setWalkAwayPoint(e.target.value)} />
      </label>

      {error && <p className="generation-error">{error}</p>}

      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? 'Сохраняем…' : 'Сохранить'}
      </button>
    </div>
  );
}
