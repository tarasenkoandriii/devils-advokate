'use client';

// Пункт 64 (backend) → TMA UI: кнопки быстрой генерации цитаты/
// анекдота по ситуации (§3.24 частично) + авто-показ по настройке
// "всегда показывать" (§3.25 ТЗ, пункт 44 общего списка). Оба вида
// контента — только для явно указавших вероисповедание, без
// предположений на основе региона.

import { useEffect, useState } from 'react';
import { NotLoadedNotice } from './NotLoadedNotice';
import {
  generateSituationalAnecdote,
  generateSituationalQuote,
  getOnboarding,
  listSituationalAnecdotes,
  listSituationalQuotes,
} from '../lib/features';
import { SituationalAnecdote, SituationalQuote } from '../lib/types';
import { SpeakButton } from './SpeakButton';
import { ModelParaphrase } from './ModelParaphrase';

interface SituationalContentSectionProps {
  projectId: string;
}

export function SituationalContentSection({ projectId }: SituationalContentSectionProps) {
  const [religionSet, setReligionSet] = useState(false);
  const [onboardingFailed, setOnboardingFailed] = useState(false);
  const [listsNotLoaded, setListsNotLoaded] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<SituationalQuote[]>([]);
  const [anecdotes, setAnecdotes] = useState<SituationalAnecdote[]>([]);
  const [generatingQuote, setGeneratingQuote] = useState(false);
  const [generatingAnecdote, setGeneratingAnecdote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Пункт [the-section-vanished-quietly] 2026-09-30 — здесь было
  // `try { … } finally { … }` БЕЗ `catch`, и два последствия.
  //
  // ПЕРВОЕ. Отказ `getOnboarding()` — непойманный reject внутри
  // `void load()`: `religionSet` оставался `false`, а строка
  // `if (loading || !religionSet) return null` УДАЛЯЛА ВСЮ СЕКЦИЮ
  // «Разрядка». Человек, указавший вероисповедание, видел экран без
  // неё и не мог узнать, почему: пропажа читается как «этого тут не
  // бывает», а не как сбой связи.
  //
  // ВТОРОЕ. `.catch(() => null)` на авто-генерации убивало обещание
  // §3.25 «всегда показывать»: настройка включена, показывать нечего,
  // и никто не сказал почему.
  //
  // Два признака, а не один: не загрузился СПИСОК и не удалась
  // АВТО-ГЕНЕРАЦИЯ — это разные вещи, и человеку они говорят разное.
  useEffect(() => {
    async function load() {
      try {
        const onboarding = await getOnboarding();
        const hasReligion = !!onboarding.religion;
        setReligionSet(hasReligion);
        if (!hasReligion) return;

        let listsFailed = false;
        const [existingQuotes, existingAnecdotes] = await Promise.all([
          listSituationalQuotes(projectId).catch(() => { listsFailed = true; return []; }),
          listSituationalAnecdotes(projectId).catch(() => { listsFailed = true; return []; }),
        ]);
        setQuotes(existingQuotes);
        setAnecdotes(existingAnecdotes);
        setListsNotLoaded(listsFailed);

        // "Всегда показывать" (§3.25) — авто-генерация при открытии
        // карточки, если ещё ни разу не генерировалось для этого проекта.
        if (onboarding.alwaysShowQuote && existingQuotes.length === 0) {
          const q = await generateSituationalQuote(projectId).catch(() => null);
          if (q) setQuotes([q]);
          else setAutoFailed(true);
        }
        if (onboarding.alwaysShowAnecdote && existingAnecdotes.length === 0) {
          const a = await generateSituationalAnecdote(projectId).catch(() => null);
          if (a) setAnecdotes([a]);
          else setAutoFailed(true);
        }
      } catch {
        // Отказ самого онбординга: секцию НЕ прячем — прятать её
        // значит утверждать, что вероисповедание не указано.
        setOnboardingFailed(true);
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

  if (loading) return null;
  // Пункт [the-section-vanished-quietly] 2026-09-30: раньше здесь
  // стояло `if (loading || !religionSet) return null` — и при сбое
  // загрузки онбординга секция исчезала целиком, выдавая аварию за
  // свойство продукта.
  if (onboardingFailed) {
    return (
      <section className="card-section">
        <p className="steelman-case__label">Разрядка</p>
        <NotLoadedNotice
          what="ваши настройки цитат и анекдотов"
          consequence="Поэтому раздел сейчас пуст. Если вы указывали вероисповедание, цитаты и анекдоты никуда не делись — их просто не удалось спросить."
        />
      </section>
    );
  }
  if (!religionSet) return null;

  return (
    <section className="situational-content-section">
      <h3>Разрядка</h3>

      {quotes.length > 0 && (
        <div className="situational-content-section__item">
          {/* Пункт [quotation-marks] 2026-09-05: метка была «🔵 Цитата»,
              а 🔵 в этом продукте означает ПУБЛИЧНЫЙ ФАКТ — то есть
              установленное. Под ней стоял парафраз, которого продукт сам
              же просил у модели вместо цитаты. */}
          <ModelParaphrase text={quotes[0].quoteText} source={quotes[0].sourceReference} />
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

      {listsNotLoaded && (
        <NotLoadedNotice
          what="уже подобранные цитаты и анекдоты этого проекта"
          consequence="Пусто здесь из-за сбоя связи, а не потому, что их не подбирали."
        />
      )}
      {autoFailed && (
        <p role="status" className="conversations-section__hint">
          Настройка «всегда показывать» включена, но подобрать фрагмент сейчас не удалось. Кнопки ниже пробуют снова.
        </p>
      )}
      {error && <p role="alert" className="generation-error">{error}</p>}
      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleShowQuote} disabled={generatingQuote}>
          {generatingQuote ? 'Подбираем…' : 'Подобрать уместный фрагмент'}
        </button>
        <button type="button" onClick={handleShowAnecdote} disabled={generatingAnecdote}>
          {generatingAnecdote ? 'Придумываем…' : 'Показать анекдот'}
        </button>
      </div>
    </section>
  );
}
