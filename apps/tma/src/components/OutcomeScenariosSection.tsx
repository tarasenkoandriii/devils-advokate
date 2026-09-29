'use client';

// Пункт 47 (backend) → TMA UI: Outcome Forecasting (§3.12 ТЗ), доводит
// пункт 23 v3-роадмапа до конца. Уровень проекта — тот же паттерн
// секции, что StakeholderMapSection/ArchetypePerspectivesSection.
// "Сценарии сравниваются рядом друг с другом" (§3.12 ТЗ) — карточки
// в стабильном порядке (самотёк/навредить/помочь/пользовательские),
// не вперемешку по времени создания (сортировка уже сделана на backend).

import { useEffect, useState } from 'react';
import { NotLoadedNotice } from './NotLoadedNotice';
import { confirmOutcomeScenario, generateOutcomeScenarios, listOutcomeScenarios } from '../lib/features';
import { AnalysisBasisNote } from './AnalysisBasisNote';
import { levelWording } from '../lib/confidence';
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

// Пункт [unmeasured-confidence] 2026-09-05: словесная шкала приходит от
// самой модели, и без источника «высокая уверенность» читается как
// заключение ПРОДУКТА о надёжности прогноза. Общий текст — в
// `lib/confidence.ts`.

export function OutcomeScenariosSection({ projectId }: OutcomeScenariosSectionProps) {
  const [scenarios, setScenarios] = useState<OutcomeScenario[]>([]);
  // Пункт [empty-looked-like-an-answer] 2026-09-24: сбой загрузки
  // ставил пустой список и молчал — экран показывал «ничего нет»
  // там, где ответа не было вовсе.
  const [notLoaded, setNotLoaded] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  async function handleConfirm(scenarioId: string, confirmed: boolean) {
    setConfirmingId(scenarioId);
    try {
      const updated = await confirmOutcomeScenario(projectId, scenarioId, confirmed);
      setScenarios((prev) => prev.map((x) => (x.id === scenarioId ? { ...x, outcomeConfirmed: updated.outcomeConfirmed ?? confirmed, outcomeConfirmedAt: updated.outcomeConfirmedAt ?? new Date().toISOString() } : x)));
    } catch {
      // тихо: подтверждение не должно ломать чтение сценариев
    } finally {
      setConfirmingId(null);
    }
  }
  const [loading, setLoading] = useState(true);
  const [userScenarioInputs, setUserScenarioInputs] = useState<string[]>(['']);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пункт [partial-basis] 2026-09-04: на чём построен ЭТОТ прогноз.
  const [basisNote, setBasisNote] = useState<string | null>(null);

  useEffect(() => {
    listOutcomeScenarios(projectId)
      .then((v) => { setScenarios(v); setNotLoaded(false); })
      .catch(() => { setScenarios([]); setNotLoaded(true); })
      .finally(() => setLoading(false));

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
      // Пункт [partial-basis] 2026-09-04: свежий ответ несёт основание
      // прогноза — на всех ли данных он построен. В сохранённом списке
      // его нет, и приписка сама об этом говорит.
      const { basisNote: basis } = await generateOutcomeScenarios(projectId, descriptions);
      setBasisNote(basis);
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
      {notLoaded && <NotLoadedNotice what="сценарии исходов" />}
      <h3>Прогноз по сценариям</h3>
      <p className="conversations-section__hint">
        🟡 Догадка ИИ — грубая, честная оценка возможного развития событий, не предсказание. Сравните сценарии рядом,
        чтобы увидеть спектр исходов, а не одно «правильное» решение.
      </p>

      <AnalysisBasisNote note={basisNote} />

      {scenarios.length > 0 && (
        <ul className="outcome-scenarios-list">
          {scenarios.map((s) => (
            <li key={s.id} className="outcome-scenarios-list__item">
              <div className="outcome-scenarios-list__header">
                <span className="outcome-scenarios-list__type">
                  {s.scenarioType === 'USER_DEFINED' ? s.userDescription : SCENARIO_LABELS[s.scenarioType as ScenarioType]}
                </span>
                <span className={`outcome-scenarios-list__confidence outcome-scenarios-list__confidence--${s.confidence.toLowerCase()}`}>
                  {levelWording(s.confidence)}
                </span>
              </div>
              <p>{s.outcomeDescription}</p>
              {s.precedentBasis && <p className="outcome-scenarios-list__note">Опора на прецедент: {s.precedentBasis}</p>}
              {s.protectedNoteHint && <p className="outcome-scenarios-list__note">💡 {s.protectedNoteHint}</p>}
              <div className="outcome-scenarios-list__confirm">
                {s.outcomeConfirmed === null || s.outcomeConfirmed === undefined ? (
                  <>
                    <span className="conversations-section__hint">Разговор состоялся? Отметьте, что случилось на самом деле — так прогнозы со временем калибруются.</span>
                    <button type="button" onClick={() => handleConfirm(s.id, true)} disabled={confirmingId === s.id}>Сбылось</button>
                    <button type="button" onClick={() => handleConfirm(s.id, false)} disabled={confirmingId === s.id}>Не сбылось</button>
                  </>
                ) : (
                  <span className="conversations-section__hint">{s.outcomeConfirmed ? '✓ сбылось' : '✕ не сбылось'} <button type="button" onClick={() => handleConfirm(s.id, !s.outcomeConfirmed)} disabled={confirmingId === s.id}>изменить</button></span>
                )}
              </div>
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
        {error && <p role="alert" className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Строим прогноз…' : 'Построить прогноз по сценариям'}
          </button>
        </div>
      </div>
    </section>
  );
}
