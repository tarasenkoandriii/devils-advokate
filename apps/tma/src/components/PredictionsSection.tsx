'use client';

// Пункт 25 (backend) → TMA UI: Prediction vs Reality (§3.60 ТЗ).
//
// Двухфазный флоу в UI: форма добавления прогноза (фаза 1) + для
// каждого прогноза без actualOutcome — кнопка "Записать фактический
// результат" (фаза 2, открывает мини-форму). После фазы 2 —
// разница/вывод от AI показываются прямо в карточке, форма больше не
// нужна для этого прогноза.

import { useEffect, useState } from 'react';
import { createPrediction, listPredictions, recordActualOutcome } from '../lib/features';
import { Prediction } from '../lib/types';
import { haptic } from '../lib/telegram';

interface PredictionsSectionProps {
  projectId: string;
}

export function PredictionsSection({ projectId }: PredictionsSectionProps) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPrediction, setNewPrediction] = useState('');
  const [adding, setAdding] = useState(false);

  function reload() {
    return listPredictions(projectId)
      .then(setPredictions)
      .catch(() => setPredictions([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleAdd() {
    const text = newPrediction.trim();
    if (!text) return;
    setAdding(true);
    try {
      await createPrediction(projectId, text);
      setNewPrediction('');
      setShowAddForm(false);
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setAdding(false);
    }
  }

  if (loading) return null;

  return (
    <section className="predictions-section">
      <h3>Прогноз против реальности</h3>

      {predictions.length === 0 && !showAddForm && (
        <p className="conversations-section__hint">
          Зафиксируйте прогноз до того, как станет известен результат — потом сравните с тем, что случилось на самом деле.
        </p>
      )}

      <ul className="predictions-list">
        {predictions.map((p) => (
          <PredictionRow key={p.id} prediction={p} onResolved={reload} />
        ))}
      </ul>

      {showAddForm ? (
        <div className="conversations-section__add">
          <label>
            Что вы прогнозируете
            <input
              value={newPrediction}
              onChange={(e) => setNewPrediction(e.target.value)}
              placeholder="Например: согласится на 2 дня удалённо"
            />
          </label>
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleAdd} disabled={adding || !newPrediction.trim()}>
              {adding ? 'Сохраняем…' : 'Сохранить прогноз'}
            </button>
            <button type="button" onClick={() => setShowAddForm(false)} disabled={adding}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowAddForm(true)}>
          + Добавить прогноз
        </button>
      )}
    </section>
  );
}

function PredictionRow({ prediction, onResolved }: { prediction: Prediction; onResolved: () => void }) {
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [actualOutcome, setActualOutcome] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResolve() {
    const text = actualOutcome.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    try {
      await recordActualOutcome(prediction.id, text);
      setShowResolveForm(false);
      onResolved();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось записать результат');
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="predictions-list__item">
      <p className="predictions-list__predicted">{prediction.predictedOutcome}</p>

      {prediction.actualOutcome ? (
        <div className="predictions-list__resolved">
          <p className="steelman-case__label">Фактический результат</p>
          <p>{prediction.actualOutcome}</p>
          {prediction.difference && (
            <>
              <p className="steelman-case__label">В чём разница</p>
              <p>{prediction.difference}</p>
            </>
          )}
          {prediction.lesson && (
            <>
              <p className="steelman-case__label">Какой вывод сделать</p>
              <p>{prediction.lesson}</p>
            </>
          )}
        </div>
      ) : showResolveForm ? (
        <div className="conversations-section__add">
          <label>
            Что случилось на самом деле
            <input value={actualOutcome} onChange={(e) => setActualOutcome(e.target.value)} />
          </label>
          {error && <p className="generation-error">{error}</p>}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleResolve} disabled={saving || !actualOutcome.trim()}>
              {saving ? 'Анализируем…' : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowResolveForm(false)} disabled={saving}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowResolveForm(true)}>
          Записать фактический результат
        </button>
      )}
    </li>
  );
}
