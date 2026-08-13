'use client';

// Пункт 47 (backend) → TMA UI: Outcome Forecasting (§3.12 ТЗ), доводит
// пункт 23 v3-роадмапа до конца. Уровень проекта — тот же паттерн
// секции, что StakeholderMapSection/ArchetypePerspectivesSection.
// "Сценарии сравниваются рядом друг с другом" (§3.12 ТЗ) — карточки
// в стабильном порядке (самотёк/навредить/помочь/пользовательские),
// не вперемешку по времени создания (сортировка уже сделана на backend).

import { useEffect, useState } from 'react';
import { generateOutcomeScenarios, listOutcomeScenarios } from '../lib/features';
import { OutcomeScenario, ScenarioType } from '../lib/types';
import { haptic } from '../lib/telegram';

interface OutcomeScenariosSectionProps {
  projectId: string;
}

const SCENARIO_LABELS: Record<ScenarioType, string> = {
  DO_NOTHING: 'Пустить на самотёк',
  ASSUME_HARM: 'Если цель — навредить',
  ASSUME_HELP: 'Если цель — помочь',
  USER_DEFINED: 'Ваш сценарий',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  LOW: 'низкая уверенность',
  MEDIUM: 'средняя уверенность',
  HIGH: 'высокая уверенность',
};

export function OutcomeScenariosSection({ projectId }: OutcomeScenariosSectionProps) {
  const [scenarios, setScenarios] = useState<OutcomeScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [userScenarioInputs, setUserScenarioInputs] = useState<string[]>(['']);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOutcomeScenarios(projectId)
      .then(setScenarios)
      .catch(() => setScenarios([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function updateUserScenario(index: number, value: string) {
    setUserScenarioInputs((prev) => prev.map((v, i) => (i === index ? value : v)));
  }

  function addUserScenarioField() {
    setUserScenarioInputs((prev) => [...prev, '']);
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const descriptions = userScenarioInputs.map((s) => s.trim()).filter(Boolean);
      await generateOutcomeScenarios(projectId, descriptions);
      const list = await listOutcomeScenarios(projectId);
      setScenarios(list);
      setUserScenarioInputs(['']);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось построить прогноз');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return null;

  return (
    <section className="outcome-scenarios-section">
      <h3>Прогноз по сценариям</h3>
      <p className="conversations-section__hint">
        🟡 Догадка ИИ — грубая, честная оценка возможного развития событий, не предсказание. Сравните сценарии рядом,
        чтобы увидеть спектр исходов, а не одно «правильное» решение.
      </p>

      {scenarios.length > 0 && (
        <ul className="outcome-scenarios-list">
          {scenarios.map((s) => (
            <li key={s.id} className="outcome-scenarios-list__item">
              <div className="outcome-scenarios-list__header">
                <span className="outcome-scenarios-list__type">
                  {s.scenarioType === 'USER_DEFINED' ? s.userDescription : SCENARIO_LABELS[s.scenarioType as ScenarioType]}
                </span>
                <span className={`outcome-scenarios-list__confidence outcome-scenarios-list__confidence--${s.confidence.toLowerCase()}`}>
                  {CONFIDENCE_LABELS[s.confidence]}
                </span>
              </div>
              <p>{s.outcomeDescription}</p>
              {s.precedentBasis && <p className="outcome-scenarios-list__note">Опора на прецедент: {s.precedentBasis}</p>}
              {s.protectedNoteHint && <p className="outcome-scenarios-list__note">💡 {s.protectedNoteHint}</p>}
            </li>
          ))}
        </ul>
      )}

      <div className="conversations-section__add">
        <label className="steelman-case__label">Свои линии поведения (необязательно)</label>
        {userScenarioInputs.map((value, i) => (
          <input
            key={i}
            value={value}
            onChange={(e) => updateUserScenario(i, e.target.value)}
            placeholder="Например: если промолчу"
          />
        ))}
        <button type="button" onClick={addUserScenarioField}>
          + Добавить ещё сценарий
        </button>
        {error && <p className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Строим прогноз…' : 'Построить прогноз по сценариям'}
          </button>
        </div>
      </div>
    </section>
  );
}
