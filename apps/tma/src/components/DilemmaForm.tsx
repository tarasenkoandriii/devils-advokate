'use client';

// MVP-фича 4: submit теперь идёт через нативную Telegram MainButton,
// а не обычную HTML-кнопку — но HTML-кнопка остаётся как fallback,
// когда useMainButton сообщает isTelegramAvailable=false (обычная
// разработка в браузере вне Telegram). Оба пути видны в JSX явно.

import { FormEvent, useState } from 'react';
import { useMainButton } from '../hooks/useMainButton';
import { haptic } from '../lib/telegram';

interface DilemmaFormProps {
  onSubmit: (input: { question: string; goal?: string }) => void;
  disabled: boolean;
}

export function DilemmaForm({ onSubmit, disabled }: DilemmaFormProps) {
  const [question, setQuestion] = useState('');
  const [goal, setGoal] = useState('');

  const trimmedQuestion = question.trim();
  const canSubmit = !disabled && trimmedQuestion.length > 0;

  function submit() {
    if (!canSubmit) return;
    haptic('light');
    onSubmit({ question: trimmedQuestion, goal: goal.trim() || undefined });
  }

  const { isTelegramAvailable } = useMainButton({
    text: disabled ? 'Генерируем аргументы…' : 'Сгенерировать аргументы',
    onClick: submit,
    visible: true,
    active: canSubmit,
    showProgress: disabled,
  });

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    // Форма используется только как fallback вне Telegram (когда есть
    // обычная HTML-кнопка ниже) — внутри Telegram сабмит идёт через
    // MainButton.onClick, не через submit формы (нативной кнопки формы
    // тогда на экране нет вообще).
    submit();
  }

  return (
    <form onSubmit={handleFormSubmit} className="dilemma-form">
      <label>
        О чём вы думаете?
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Например: стоит ли просить о повышении зарплаты в этом квартале"
          rows={3}
          required
        />
      </label>
      <label>
        Какого результата вы хотите добиться? (необязательно)
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Например: повышение на 20% без смены роли"
        />
      </label>

      {!isTelegramAvailable && (
        <button type="submit" disabled={!canSubmit}>
          {disabled ? 'Генерируем аргументы…' : 'Сгенерировать аргументы'}
        </button>
      )}
    </form>
  );
}
