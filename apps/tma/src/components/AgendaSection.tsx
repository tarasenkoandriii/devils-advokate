'use client';

// Пункт 27 (backend) → TMA UI: Conversation Agenda (раздел 2 ТЗ, MVP v2
// пункт 15) — "AI формирует agenda на основе прошлого + текущей цели"
// (buкально ТЗ). Найдено полным аудитом кода/тестов/документации/
// фронтенда — backend был полностью рабочим и протестированным с
// Пункта 27, но не имел ни единого потребителя в TMA. Простой паттерн
// "сгенерировать по кнопке → показать последний результат", тот же
// класс, что MissingInformationSection/EvidenceGapSection — снимок,
// не мутируемый список, повторная генерация создаёт НОВУЮ запись.

import { useEffect, useState } from 'react';
import { generateAgenda, getLatestAgenda } from '../lib/features';
import { ConversationAgenda } from '../lib/types';
import { haptic } from '../lib/telegram';

interface AgendaSectionProps {
  projectId: string;
}

export function AgendaSection({ projectId }: AgendaSectionProps) {
  const [agenda, setAgenda] = useState<ConversationAgenda | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLatestAgenda(projectId)
      .then(setAgenda)
      .catch(() => setAgenda(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const result = await generateAgenda(projectId);
      setAgenda(result);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сформировать повестку');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return null;

  return (
    <section className="agenda-section">
      <h3>Повестка следующего разговора</h3>
      <p className="conversations-section__hint">
        AI формирует список пунктов на основе прошлых разговоров этого проекта и текущей цели — не повторяет уже
        решённое, фокусируется на незакрытом и новом.
      </p>

      {agenda ? (
        <>
          <p className="conversations-section__hint">Сформирована {new Date(agenda.createdAt).toLocaleString()}</p>
          <ul className="agenda-section__items">
            {agenda.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="conversations-section__hint">Повестка ещё не формировалась.</p>
      )}

      {error && <p className="generation-error">{error}</p>}

      <button type="button" onClick={handleGenerate} disabled={generating}>
        {generating ? 'Формируем…' : agenda ? 'Сформировать заново' : 'Сформировать повестку'}
      </button>
    </section>
  );
}
