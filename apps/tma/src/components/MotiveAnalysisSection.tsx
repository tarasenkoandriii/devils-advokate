'use client';

// Пункт 59 (backend) → TMA UI: анализ вероятных мотивов (§3.18 ТЗ),
// пункт 28 v3-роадмапа. Публичный поиск (имущественное положение по
// реестрам) СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАН — только синтез уже накопленных
// личных данных, см. обоснование в apps/api/prisma/README.md, «Пункт
// 59». Формулировки в UI — "возможное объяснение", никогда "его
// мотив" как факт.

import { useEffect, useState } from 'react';
import { analyzeMotives, confirmSuggestedStatus, listMotiveHypotheses } from '../lib/features';
import { MotiveHypothesis, PersonStatus } from '../lib/types';
import { haptic } from '../lib/telegram';

interface MotiveAnalysisSectionProps {
  projectId: string;
  personId: string;
  // Пункт 74 (§3.38 ТЗ) — предложение смены статуса показывается,
  // только пока персона ещё не фигурант, и требует явного
  // подтверждения — "автоматическое молчаливое переключение статуса
  // признано опасным" (buкально ТЗ). onStatusConfirmed — тот же
  // паттерн onChanged(), что уже используется в PeopleSection.tsx для
  // ручного переключения, переиспользован для консистентности.
  currentStatus: PersonStatus;
  onStatusConfirmed: () => void;
}

export function MotiveAnalysisSection({ projectId, personId, currentStatus, onStatusConfirmed }: MotiveAnalysisSectionProps) {
  const [hypotheses, setHypotheses] = useState<MotiveHypothesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMotiveHypotheses(projectId, personId)
      .then(setHypotheses)
      .catch(() => setHypotheses([]))
      .finally(() => setLoading(false));
  }, [projectId, personId]);

  async function handleAnalyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const created = await analyzeMotives(projectId, personId);
      setHypotheses((prev) => [...created, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось построить гипотезы о мотивах');
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleConfirmStatus() {
    setConfirming(true);
    try {
      await confirmSuggestedStatus(projectId, personId);
      onStatusConfirmed();
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setConfirming(false);
    }
  }

  if (loading) return null;

  const hasSuggestion = currentStatus === 'PERSONA' && !dismissed && hypotheses.some((h) => h.suggestsFigurantStatus);

  return (
    <section className="motive-analysis-section">
      <h3>Возможные мотивы</h3>
      <p className="conversations-section__hint">
        🟡 Альтернативные гипотезы на основе уже известного о человеке, не установленный факт о его целях. Поиск по
        публичным реестрам/декларациям не выполняется — только то, что вы уже знаете и внесли сами.
      </p>

      {hasSuggestion && (
        <div className="motive-analysis-section__suggestion">
          <p>Среди гипотез есть указание на реальный конфликт целей — переключить статус в «Фигурант»?</p>
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleConfirmStatus} disabled={confirming}>
              {confirming ? 'Переключаем…' : 'Подтвердить'}
            </button>
            <button type="button" onClick={() => setDismissed(true)} disabled={confirming}>
              Не сейчас
            </button>
          </div>
        </div>
      )}

      {hypotheses.length > 0 && (
        <ul className="motive-analysis-section__list">
          {hypotheses.map((h) => (
            <li key={h.id} className="motive-analysis-section__item">
              <span className={`motive-analysis-section__confidence motive-analysis-section__confidence--${h.confidence.toLowerCase()}`}>
                {h.confidence === 'LOW' && 'Низкая уверенность'}
                {h.confidence === 'MEDIUM' && 'Средняя уверенность'}
                {h.confidence === 'HIGH' && 'Высокая уверенность'}
              </span>
              <span>{h.explanation}</span>
              <span className="motive-analysis-section__note">На основании: {h.supportingFactsSummary}</span>
              {h.alignmentWithUserGoal && <span className="motive-analysis-section__note">Совпадение/конфликт целей: {h.alignmentWithUserGoal}</span>}
              {h.compromiseSuggestion && <span className="motive-analysis-section__note">Вариант компромисса: {h.compromiseSuggestion}</span>}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="generation-error">{error}</p>}
      <button type="button" onClick={handleAnalyze} disabled={analyzing}>
        {analyzing ? 'Анализируем…' : 'Построить гипотезы о мотивах'}
      </button>
    </section>
  );
}
