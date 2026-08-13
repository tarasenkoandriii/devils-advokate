'use client';

// MVP-фича 6: форма Decision Objective. Обычная HTML-кнопка сохранения,
// не нативная MainButton — на этой же странице (детали проекта) уже
// занят BackButton, а MainButton в Telegram один на экран; занимать его
// под второстепенное действие "сохранить цель" было бы конфликтом с
// более важным действием на этом экране (если оно появится позже).
// Списки (constraints/nonNegotiables/negotiables) — textarea, один
// пункт на строку, не отдельные динамические поля-теги: проще в
// реализации и достаточно для MVP.

import { useEffect, useState } from 'react';
import { getObjective, saveObjective } from '../lib/features';

interface DecisionObjectiveFormProps {
  projectId: string;
  onSaved?: () => void;
}

function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listToLines(list: string[]): string {
  return list.join('\n');
}

export function DecisionObjectiveForm({ projectId, onSaved }: DecisionObjectiveFormProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [desiredOutcome, setDesiredOutcome] = useState('');
  const [idealOutcome, setIdealOutcome] = useState('');
  const [minimumAcceptableOutcome, setMinimumAcceptableOutcome] = useState('');
  const [unacceptableOutcome, setUnacceptableOutcome] = useState('');
  const [deadline, setDeadline] = useState('');
  const [constraints, setConstraints] = useState('');
  const [nonNegotiables, setNonNegotiables] = useState('');
  const [negotiables, setNegotiables] = useState('');
  const [doNotSay, setDoNotSay] = useState('');

  useEffect(() => {
    getObjective(projectId)
      .then((obj) => {
        if (!obj) return;
        setDesiredOutcome(obj.desiredOutcome ?? '');
        setIdealOutcome(obj.idealOutcome ?? '');
        setMinimumAcceptableOutcome(obj.minimumAcceptableOutcome ?? '');
        setUnacceptableOutcome(obj.unacceptableOutcome ?? '');
        setDeadline(obj.deadline ? obj.deadline.split('T')[0] : '');
        setConstraints(listToLines(obj.constraints));
        setNonNegotiables(listToLines(obj.nonNegotiables));
        setNegotiables(listToLines(obj.negotiables));
        setDoNotSay(listToLines(obj.doNotSay ?? []));
        if (obj.desiredOutcome || obj.idealOutcome) setExpanded(true);
      })
      .catch(() => {
        // Отсутствие DecisionObjective — не ошибка (первый визит на
        // проект), молча оставляем форму пустой.
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveObjective(projectId, {
        desiredOutcome: desiredOutcome || undefined,
        idealOutcome: idealOutcome || undefined,
        minimumAcceptableOutcome: minimumAcceptableOutcome || undefined,
        unacceptableOutcome: unacceptableOutcome || undefined,
        deadline: deadline || undefined,
        constraints: linesToList(constraints),
        nonNegotiables: linesToList(nonNegotiables),
        negotiables: linesToList(negotiables),
        doNotSay: linesToList(doNotSay),
      });
      onSaved?.();
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
        + Уточнить цель разговора
      </button>
    );
  }

  return (
    <div className="decision-objective-form">
      <h3>Цель разговора</h3>
      <p className="decision-objective-form__hint">
        Необязательно, но помогает генерировать более точные аргументы под вашу ситуацию.
      </p>

      <label>
        Желаемый исход
        <input value={desiredOutcome} onChange={(e) => setDesiredOutcome(e.target.value)} />
      </label>
      <label>
        Идеальный исход
        <input value={idealOutcome} onChange={(e) => setIdealOutcome(e.target.value)} />
      </label>
      <label>
        Минимально приемлемый результат
        <input
          value={minimumAcceptableOutcome}
          onChange={(e) => setMinimumAcceptableOutcome(e.target.value)}
        />
      </label>
      <label>
        Неприемлемо (красная черта)
        <input value={unacceptableOutcome} onChange={(e) => setUnacceptableOutcome(e.target.value)} />
      </label>
      <label>
        Срок
        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <label>
        Ограничения (по одному на строку)
        <textarea rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
      </label>
      <label>
        Не подлежит обсуждению (по одному на строку)
        <textarea rows={2} value={nonNegotiables} onChange={(e) => setNonNegotiables(e.target.value)} />
      </label>
      <label>
        Можно поступиться (по одному на строку)
        <textarea rows={2} value={negotiables} onChange={(e) => setNegotiables(e.target.value)} />
      </label>
      <label>
        Не стоит упоминать (по одному на строку)
        <textarea rows={2} value={doNotSay} onChange={(e) => setDoNotSay(e.target.value)} />
      </label>

      {error && <p className="generation-error">{error}</p>}

      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? 'Сохраняем…' : 'Сохранить цель'}
      </button>
    </div>
  );
}
