'use client';

// Пункт 64 (backend) → TMA UI: кнопки быстрой генерации цитаты/
// анекдота по ситуации (§3.24 частично) + авто-показ по настройке
// "всегда показывать" (§3.25 ТЗ, пункт 44 общего списка). Оба вида
// контента — только для явно указавших вероисповедание, без
// предположений на основе региона.

import { useEffect, useState } from 'react';
import {
  generateSituationalAnecdote,
  generateSituationalQuote,
  getOnboarding,
  listSituationalAnecdotes,
  listSituationalQuotes,
} from '../lib/features';
import { SituationalAnecdote, SituationalQuote } from '../lib/types';
import { SpeakButton } from './SpeakButton';

interface SituationalContentSectionProps {
  projectId: string;
}

export function SituationalContentSection({ projectId }: SituationalContentSectionProps) {
  const [religionSet, setReligionSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<SituationalQuote[]>([]);
  const [anecdotes, setAnecdotes] = useState<SituationalAnecdote[]>([]);
  const [generatingQuote, setGeneratingQuote] = useState(false);
  const [generatingAnecdote, setGeneratingAnecdote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const onboarding = await getOnboarding();
        const hasReligion = !!onboarding.religion;
        setReligionSet(hasReligion);
        if (!hasReligion) return;

        const [existingQuotes, existingAnecdotes] = await Promise.all([
          listSituationalQuotes(projectId).catch(() => []),
          listSituationalAnecdotes(projectId).catch(() => []),
        ]);
        setQuotes(existingQuotes);
        setAnecdotes(existingAnecdotes);

        // "Всегда показывать" (§3.25) — авто-генерация при открытии
        // карточки, если ещё ни разу не генерировалось для этого проекта.
        if (onboarding.alwaysShowQuote && existingQuotes.length === 0) {
          const q = await generateSituationalQuote(projectId).catch(() => null);
          if (q) setQuotes([q]);
        }
        if (onboarding.alwaysShowAnecdote && existingAnecdotes.length === 0) {
          const a = await generateSituationalAnecdote(projectId).catch(() => null);
          if (a) setAnecdotes([a]);
        }
      } finally {
        setLoading(false);
      }
    }
    void load();

  }, [projectId]);

  async function handleShowQuote() {
    setGeneratingQuote(true);
    setError(null);
    try {
      const q = await generateSituationalQuote(projectId);
      setQuotes((prev) => [q, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подобрать цитату');
    } finally {
      setGeneratingQuote(false);
    }
  }

  async function handleShowAnecdote() {
    setGeneratingAnecdote(true);
    setError(null);
    try {
      const a = await generateSituationalAnecdote(projectId);
      setAnecdotes((prev) => [a, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось придумать анекдот');
    } finally {
      setGeneratingAnecdote(false);
    }
  }

  if (loading || !religionSet) return null;

  return (
    <section className="situational-content-section">
      <h3>Разрядка</h3>

      {quotes.length > 0 && (
        <div className="situational-content-section__item">
          <span className="steelman-case__label">🔵 Цитата</span>
          <span>{quotes[0].quoteText}</span>
          <span className="situational-content-section__source">— {quotes[0].sourceReference}</span>
          <SpeakButton text={quotes[0].quoteText} />
        </div>
      )}
      {anecdotes.length > 0 && (
        <div className="situational-content-section__item">
          <span className="steelman-case__label">Анекдот</span>
          <span>{anecdotes[0].text}</span>
          <SpeakButton text={anecdotes[0].text} />
        </div>
      )}

      {error && <p className="generation-error">{error}</p>}
      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleShowQuote} disabled={generatingQuote}>
          {generatingQuote ? 'Подбираем…' : 'Показать релевантную цитату'}
        </button>
        <button type="button" onClick={handleShowAnecdote} disabled={generatingAnecdote}>
          {generatingAnecdote ? 'Придумываем…' : 'Показать анекдот'}
        </button>
      </div>
    </section>
  );
}
