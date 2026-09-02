'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { bootstrap, listConsents, hasConsent, createProject, generateArguments } from '../lib/features';
import { ApiRequestError } from '../lib/api';
import { haptic } from '../lib/telegram';
import { Argument, ConsentRecord } from '../lib/types';
import { ConsentGate } from '../components/ConsentGate';
import { DilemmaForm } from '../components/DilemmaForm';
import { ArgumentsList } from '../components/ArgumentsList';
import { EngineSelector } from '../components/EngineSelector';
import { ShareButton } from '../components/ShareButton';
import { ReligiousReminderBanner } from '../components/ReligiousReminderBanner';

type LoadState = 'loading' | 'ready' | 'error';

export default function HomePage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [engineId, setEngineId] = useState<string | undefined>(undefined);

  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationErrorKind, setGenerationErrorKind] = useState<'consent' | 'blocked' | 'other' | null>(null);
  const [results, setResults] = useState<Argument[]>([]);
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string>('');

  // Дисклеймер здесь больше НЕ проверяется — AppGate в корневом layout
  // (components/AppGate.tsx) гарантирует, что эта страница вообще не
  // отрендерится, пока пользователь не подтвердит. bootstrap() здесь
  // остаётся ради собственных целей страницы — согласия, privacyProcessingMode.
  useEffect(() => {
    async function init() {
      try {
        await bootstrap();
        const consentList = await listConsents();
        setConsents(consentList);
        setLoadState('ready');
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить приложение');
        setLoadState('error');
      }
    }
    void init();
  }, []);

  async function handleSubmit(input: { question: string; goal?: string }) {
    setGenerating(true);
    setGenerationError(null);
    setGenerationErrorKind(null);
    setResults([]);
    setLastProjectId(null);

    try {
      const project = await createProject(input);
      const generatedArguments = await generateArguments(project.id, engineId);
      setResults(generatedArguments);
      setLastProjectId(project.id);
      setLastQuestion(input.question);
      haptic('success');
    } catch (err) {
      haptic('error');
      if (err instanceof ApiRequestError) {
        if (err.httpStatus === 403) {
          setGenerationErrorKind('consent');
          setConsents([]);
        } else if (err.httpStatus === 400) {
          setGenerationErrorKind('blocked');
        } else {
          setGenerationErrorKind('other');
        }
        setGenerationError(err.message);
      } else {
        setGenerationErrorKind('other');
        setGenerationError('Неизвестная ошибка');
      }
    } finally {
      setGenerating(false);
    }
  }

  if (loadState === 'loading') {
    return <main className="page page--loading">Загрузка…</main>;
  }

  if (loadState === 'error') {
    return (
      <main className="page page--error">
        <p>Не удалось загрузить приложение: {loadError}</p>
      </main>
    );
  }

  const externalAiGranted = hasConsent(consents, 'EXTERNAL_AI');

  return (
    <main className="page">
      <h1>Devil&apos;s Advocate</h1>
      <ReligiousReminderBanner />
      <p>
        <Link href="/intake">🎤 Не знаете, с чего начать? →</Link> · <Link href="/domains">Сценарии →</Link> · <Link href="/projects">Мои разговоры →</Link> · <Link href="/privacy">Приватность →</Link> · <Link href="/calibration">Калибровка решений →</Link> · <Link href="/library">Библиотека →</Link> · <Link href="/settings">Настройки →</Link> · <Link href="/venues">Заведения →</Link>
      </p>

      {!externalAiGranted && (
        <ConsentGate
          onGranted={() =>
            setConsents((prev) => [
              ...prev,
              { id: 'local', consentType: 'EXTERNAL_AI', granted: true, purposes: [] },
            ])
          }
        />
      )}

      {externalAiGranted && (
        <>
          <EngineSelector value={engineId} onChange={setEngineId} />
          <DilemmaForm onSubmit={handleSubmit} disabled={generating} />

          {generationError && (
            <p className={`generation-error generation-error--${generationErrorKind}`}>
              {generationErrorKind === 'blocked'
                ? 'Запрос отклонён проверкой безопасности — переформулируйте вопрос без служебных инструкций внутри текста.'
                : generationErrorKind === 'consent'
                  ? 'Согласие на использование AI отозвано — подтвердите ещё раз.'
                  : `Не удалось сгенерировать аргументы: ${generationError}`}
            </p>
          )}

          {results.length > 0 && lastProjectId && (
            <ArgumentsList arguments={results} projectId={lastProjectId} />
          )}

          {results.length > 0 && (
            <ShareButton question={lastQuestion} arguments={results} projectId={lastProjectId ?? undefined} />
          )}

          {lastProjectId && results.length > 0 && (
            <p>
              <Link href={`/projects/${lastProjectId}`}>Открыть этот разговор в истории →</Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
