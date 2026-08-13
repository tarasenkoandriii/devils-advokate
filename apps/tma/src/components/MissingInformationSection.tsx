'use client';

// Пункт 16 (backend) → TMA UI: Missing Information (§3.51 ТЗ).
//
// Кнопка "Проверить, чего не хватает" + список вопросов от последней
// проверки. НЕ жёсткий гейт перед генерацией аргументов — по прямому
// решению на бэкенде (см. missing-information.service.ts) это отдельный
// AI-вызов по запросу, не блокирующий другие действия на странице.
// Отображается сразу под DecisionObjectiveForm — ТЗ прямо указывает,
// что источник недостающей информации чаще всего именно её
// незаполненные поля.

import { useEffect, useState } from 'react';
import { detectMissingInformation, getLatestMissingInformation } from '../lib/features';
import { MissingInformationCheck } from '../lib/types';
import { haptic } from '../lib/telegram';

interface MissingInformationSectionProps {
  projectId: string;
}

export function MissingInformationSection({ projectId }: MissingInformationSectionProps) {
  const [check, setCheck] = useState<MissingInformationCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLatestMissingInformation(projectId)
      .then(setCheck)
      .catch(() => setCheck(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleDetect() {
    setDetecting(true);
    setError(null);
    try {
      const result = await detectMissingInformation(projectId);
      setCheck(result);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось проверить полноту информации');
    } finally {
      setDetecting(false);
    }
  }

  if (loading) return null;

  return (
    <section className="missing-information-section">
      <h3>Чего не хватает</h3>

      {check && check.questions.length > 0 && (
        <ul className="missing-information-section__list">
          {check.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      )}

      {check && check.questions.length === 0 && (
        <p className="conversations-section__hint">Ключевой информации хватает — проверено {new Date(check.createdAt).toLocaleString()}.</p>
      )}

      {!check && (
        <p className="conversations-section__hint">
          Перед тем как строить аргументы — проверьте, не упущено ли что-то важное о ситуации.
        </p>
      )}

      {error && <p className="generation-error">{error}</p>}

      <button type="button" onClick={handleDetect} disabled={detecting}>
        {detecting ? 'Проверяем…' : check ? 'Проверить ещё раз' : 'Проверить, чего не хватает'}
      </button>
    </section>
  );
}
