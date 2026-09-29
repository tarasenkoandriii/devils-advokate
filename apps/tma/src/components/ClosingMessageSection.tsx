'use client';

// Пункт 72 (backend) → TMA UI: завершающее сообщение (§3.35 ТЗ).
// Отдельный, изолированный компонент — не встроен в уже рабочий
// DecisionOutcomeSection.tsx, только естественно следует за ним на
// странице проекта (backend сам требует зафиксированный исход, здесь
// это отражается дружелюбным сообщением при ошибке 400, не заранее
// скрытой кнопкой — пользователь видит саму фичу и понимает, чего ей
// не хватает).

import { useEffect, useState } from 'react';
import { NotLoadedNotice } from './NotLoadedNotice';
import { generateClosingMessage, listClosingMessages } from '../lib/features';
import { ApiRequestError } from '../lib/api';
import { ClosingMessage } from '../lib/types';
import { haptic } from '../lib/telegram';
import { SpeakButton } from './SpeakButton';
import { ModelParaphrase, ModelWrittenNote } from './ModelParaphrase';

interface ClosingMessageSectionProps {
  projectId: string;
}

export function ClosingMessageSection({ projectId }: ClosingMessageSectionProps) {
  const [messages, setMessages] = useState<ClosingMessage[]>([]);
  // Пункт [empty-looked-like-an-answer] 2026-09-24: сбой загрузки
  // ставил пустой список и молчал — экран показывал «ничего нет»
  // там, где ответа не было вовсе.
  const [notLoaded, setNotLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listClosingMessages(projectId)
      .then((v) => { setMessages(v); setNotLoaded(false); })
      .catch(() => { setMessages([]); setNotLoaded(true); })
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const message = await generateClosingMessage(projectId);
      setMessages((prev) => [message, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      if (err instanceof ApiRequestError && err.httpStatus === 400) {
        setError(err.message); // backend уже формулирует это дружелюбно: "сначала зафиксируйте исход решения"
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось составить завершающее сообщение');
      }
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return null;

  return (
    <section className="closing-message-section">
      {notLoaded && <NotLoadedNotice what="завершающие сообщения" />}
      <h3>Завершающее сообщение</h3>
      <p className="conversations-section__hint">Честный итог по завершении — не сухая статистика и не приукрашивание.</p>
      <ModelWrittenNote what="Итог" />

      {messages.map((m) => (
        <div key={m.id} className="closing-message-section__message">
          <p className="script-text">{m.summaryText}</p>
          {/* Пункт [quotation-marks] 2026-09-05: кавычки с атрибуцией —
              знак дословности, а промпт САМ требует от модели парафраз.
              Продукт знал, что это не цитата, и показывал как цитату. */}
          {m.quoteText && <ModelParaphrase text={m.quoteText} source={m.quoteSourceReference} />}
          <SpeakButton text={m.summaryText} />
        </div>
      ))}

      {error && <p role="alert" className="generation-error">{error}</p>}
      <button type="button" onClick={handleGenerate} disabled={generating}>
        {generating ? 'Составляем…' : 'Составить завершающее сообщение'}
      </button>
    </section>
  );
}
