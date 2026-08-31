'use client';

// Пункт 83 (§3.33 ТЗ) → TMA UI: экран сопровождения разговора,
// проход 1 из двух согласованных срезов. Объединяет:
// (1) категориальный индикатор накала — чисто клиентский, непрерывный,
//     построен на уже готовой акустике Пункта 81 (categorizeEscalation);
// (2) live-детектор уловок — циклический вызов backend, тот же
//     паттерн (до 30 секунд), что LiveHintsSession.tsx (Пункт 82).
//
// Пункт 84 (§3.33 ТЗ, проход 2) РАСШИРЯЕТ этот же компонент, не
// строит отдельную точку входа — buкально та же секция ТЗ, оба
// прохода концептуально одна фича "экран сопровождения":
// (3) breaking-вопросы по требованию — не циклично, кнопка;
// (4) динамический трекинг аргументов — карточки с тремя визуальными
//     состояниями, частота проверки растёт вместе с накалом (2).
//
// Пункт 86 (§3.37 ТЗ) добавил (5) детектор прощупывания —
// "симметрично детектору уловок" (buкально ТЗ), тот же 30-секундный
// цикл, что (2), но ОТДЕЛЬНАЯ семантика: накопительный паттерн через
// несколько циклов ("дважды, трижды"), не разовое событие в одном
// окне — backend сам решает, показывать ли предупреждение (только
// при repeatCount >= 2), клиент просто отображает то, что вернулось.
//
// НАМЕРЕННО ОТДЕЛЬНАЯ ТОЧКА ВХОДА ОТ ДРУГИХ LIVE-ФИЧ, тот же принцип,
// что CooldownNudgeSession.tsx/LiveHintsSession.tsx — не объединена
// молча с НИМИ, но все пять кусков §3.33/§3.37 — один компонент.
//
// ВНУТРЕННИЙ ЧИСЛОВОЙ SCORE НИКОГДА НЕ ПОКАЗЫВАЕТСЯ ПОЛЬЗОВАТЕЛЮ —
// buкально ТЗ. Компонент показывает только category + текстовое
// пояснение "оценка модели на основе голосовых сигналов".

import { useEffect, useRef, useState } from 'react';
import { startLiveAudioCapture, LiveAudioCaptureHandle, CaptureState } from '../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle, TranscriptUpdate } from '../lib/live-transcription';
import { computeRmsDb, categorizeEscalation, VolumeWindow, EscalationCategory } from '../lib/acoustic-monitor';
import { loadVoiceEmbeddingExtractor, embeddingToArray } from '../lib/voice-embedding';
import { checkThirdPartyAudioConsent, ThirdPartyAudioConsentPrompt } from './ThirdPartyAudioConsentPrompt';
import {
  mintTranscriptionToken,
  analyzeLiveManipulation,
  generateBreakingQuestions,
  initializeArgumentTracking,
  checkArgumentTrackingStatus,
  logEscalationCategory,
  analyzeProbing,
  getVoiceEnrollmentStatus,
  verifyVoiceEmbedding,
} from '../lib/features';
import { LiveManipulationFlag, BreakingQuestionSet, LiveArgumentTrackingStatus, ProbingTopic } from '../lib/types';
import { haptic } from '../lib/telegram';

interface AssistanceScreenProps {
  projectId: string;
}

const SAMPLE_INTERVAL_MS = 500;
const MANIPULATION_CYCLE_MS = 30_000; // до 30 секунд — тот же согласованный цикл, что Live Hints
const PROBING_CYCLE_MS = 30_000; // "симметрично детектору уловок" — buкально ТЗ, тот же цикл
const TRANSCRIPT_WINDOW_MS = 10 * 60 * 1000;
const VOICE_MODEL_URL = '/models/speaker-embedding.onnx';
// "Частота проверки повышается во время эскалации" — buкально ТЗ.
// Не единый фиксированный интервал — самопланирующийся цикл ниже
// перечитывает актуальную категорию накала при каждом тике.
const TRACKING_INTERVAL_CALM_MS = 45_000;
const TRACKING_INTERVAL_ESCALATED_MS = 15_000;

const CATEGORY_LABEL: Record<EscalationCategory, string> = {
  CALM: '🟢 Спокойно',
  RISING: '🟡 Накал растёт',
  HIGH: '🟠 Высокий накал',
  CRITICAL: '🔴 Риск срыва разговора',
};

const TRACKING_STATE_LABEL: Record<string, string> = {
  NOT_MENTIONED: 'Ещё не упомянут',
  NEEDS_REPEAT: 'Стоит повторить',
  SUFFICIENTLY_MENTIONED: 'Достаточно раскрыт',
  GENUINELY_ACCEPTED: '🟢 Принято собеседником',
};

interface TranscriptSegment {
  text: string;
  timestamp: number;
  speakerLabel?: string;
}

export function AssistanceScreen({ projectId }: AssistanceScreenProps) {
  const [expanded, setExpanded] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [needsAudioConsent, setNeedsAudioConsent] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [category, setCategory] = useState<EscalationCategory | null>(null);
  const [flags, setFlags] = useState<LiveManipulationFlag[]>([]);
  const [breakingQuestions, setBreakingQuestions] = useState<BreakingQuestionSet | null>(null);
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [trackedArguments, setTrackedArguments] = useState<LiveArgumentTrackingStatus[]>([]);
  const [probingWarnings, setProbingWarnings] = useState<ProbingTopic[]>([]);

  const captureHandleRef = useRef<LiveAudioCaptureHandle | null>(null);
  const transcriptionHandleRef = useRef<LiveTranscriptionHandle | null>(null);
  const volumeWindowsRef = useRef<VolumeWindow[]>([]);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  // Пункт 87 — карта "метка диаризации → это я или нет", заполняется
  // один раз на новую метку за сессию, не пересчитывается на каждую реплику.
  const speakerSelfMapRef = useRef<Map<string, boolean>>(new Map());
  const voiceExtractorRef = useRef<Awaited<ReturnType<typeof loadVoiceEmbeddingExtractor>>>(null);
  const rawSamplesBufferRef = useRef<Float32Array[]>([]);
  const volumeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manipulationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const probingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref, не только state — setTimeout-коллбэк ниже иначе видел бы
  // устаревшее значение category из замыкания на момент планирования.
  const categoryRef = useRef<EscalationCategory | null>(null);
  // Пункт 85 — sessionId генерируется один раз при старте, группирует
  // все переходы категории этого непрерывного запуска на backend.
  // lastLoggedCategoryRef — логируем только ПЕРЕХОДЫ, не каждый
  // замер (раз в 500мс было бы избыточно и не нужно для метрики).
  const sessionIdRef = useRef<string | null>(null);
  const lastLoggedCategoryRef = useRef<EscalationCategory | null>(null);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  useEffect(() => {
    return () => {
      transcriptionHandleRef.current?.stop();
      captureHandleRef.current?.stop();
      if (volumeIntervalRef.current) clearInterval(volumeIntervalRef.current);
      if (manipulationIntervalRef.current) clearInterval(manipulationIntervalRef.current);
      if (probingIntervalRef.current) clearInterval(probingIntervalRef.current);
      if (trackingTimeoutRef.current) clearTimeout(trackingTimeoutRef.current);
    };
  }, []);

  function handleTranscript(update: TranscriptUpdate) {
    if (!update.isFinal) return;
    segmentsRef.current.push({ text: update.text, timestamp: Date.now(), speakerLabel: update.speakerLabel });

    // Пункт 87 — определяем "я/не я" ОДИН РАЗ на новую метку диаризации.
    // Честная оговорка: сравнение идёт по накопленному недавнему сырому
    // аудио-буферу (последние ~3с), не по точно выровненному окну именно
    // этой реплики говорящего — таких таймингов у нас нет. Приближение,
    // не точная привязка, задокументировано явно.
    if (update.speakerLabel && !speakerSelfMapRef.current.has(update.speakerLabel) && voiceExtractorRef.current) {
      const recentSamples = rawSamplesBufferRef.current.slice(-6); // последние ~3с при 500мс тиках
      if (recentSamples.length > 0) {
        const merged = new Float32Array(recentSamples.reduce((sum, arr) => sum + arr.length, 0));
        let offset = 0;
        for (const arr of recentSamples) {
          merged.set(arr, offset);
          offset += arr.length;
        }
        const embedding = voiceExtractorRef.current.extractEmbedding(merged, 16000);
        if (embedding) {
          verifyVoiceEmbedding(embeddingToArray(embedding))
            .then((result) => {
              if (result.isMatch !== null) {
                speakerSelfMapRef.current.set(update.speakerLabel as string, result.isMatch);
              }
            })
            .catch(() => {});
        }
      }
    }
  }

  /** Только реплики "не я" — buкально смысл детектора прощупывания
   * (§3.37: "собеседник пытается что-то выведать", не сам пользователь).
   * Если метка ещё не определена (speakerSelfMapRef не содержит её) —
   * честно ВКЛЮЧАЕМ такую реплику (не отфильтровываем неопределённость
   * молча), чтобы не терять реальные сигналы из-за задержки определения. */
  function getRecentTranscriptWindowExcludingSelf(): string {
    const now = Date.now();
    const windowStart = now - TRANSCRIPT_WINDOW_MS;
    segmentsRef.current = segmentsRef.current.filter((s) => s.timestamp >= windowStart);
    return segmentsRef.current
      .filter((s) => {
        if (!s.speakerLabel) return true; // без диаризации — честно не фильтруем вообще
        const isSelf = speakerSelfMapRef.current.get(s.speakerLabel);
        return isSelf !== true; // undefined (ещё не определено) или false — включаем
      })
      .map((s) => s.text)
      .join(' ');
  }

  function getRecentTranscriptWindow(): string {
    const now = Date.now();
    const windowStart = now - TRANSCRIPT_WINDOW_MS;
    segmentsRef.current = segmentsRef.current.filter((s) => s.timestamp >= windowStart);
    return segmentsRef.current.map((s) => s.text).join(' ');
  }

  function scheduleTrackingCheck() {
    const currentCategory = categoryRef.current;
    const delay = !currentCategory || currentCategory === 'CALM' ? TRACKING_INTERVAL_CALM_MS : TRACKING_INTERVAL_ESCALATED_MS;
    trackingTimeoutRef.current = setTimeout(async () => {
      const transcriptWindow = getRecentTranscriptWindow();
      if (transcriptWindow.trim()) {
        try {
          const updated = await checkArgumentTrackingStatus(projectId, transcriptWindow);
          if (updated.length > 0) {
            setTrackedArguments((prev) => {
              const byId = new Map(prev.map((s) => [s.argumentId, s]));
              for (const u of updated) byId.set(u.argumentId, u);
              return Array.from(byId.values());
            });
          }
        } catch {
          // Тихий сбой цикла не должен ломать саму сессию.
        }
      }
      scheduleTrackingCheck(); // перепланируем с актуальной на этот момент категорией
    }, delay);
  }

  async function handleStart() {
    if (!(await checkThirdPartyAudioConsent())) { setNeedsAudioConsent(true); return; }
    const captureHandle = await startLiveAudioCapture((state, errorMessage) => {
      setCaptureState(state);
      setCaptureError(errorMessage);
    });
    if (!captureHandle) return;
    captureHandleRef.current = captureHandle;
    volumeWindowsRef.current = [];
    segmentsRef.current = [];
    setCategory(null);
    setFlags([]);
    setProbingWarnings([]);
    // Пункт 85 — новый sessionId на каждый запуск, сбрасываем "последнюю залогированную" категорию.
    sessionIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    lastLoggedCategoryRef.current = null;
    setBreakingQuestions(null);

    // Пункт 87 — если у пользователя есть регистрация голоса, заранее
    // загружаем экстрактор эмбеддинга. Тихий сбой (нет регистрации, не
    // удалось загрузить WASM) не должен ломать остальную сессию —
    // детектор прощупывания просто продолжает работать без фильтрации
    // "я/не я", как раньше.
    speakerSelfMapRef.current = new Map();
    rawSamplesBufferRef.current = [];
    getVoiceEnrollmentStatus()
      .then((status) => {
        if (!status.enrolled) return;
        return loadVoiceEmbeddingExtractor(VOICE_MODEL_URL).then((extractor) => {
          voiceExtractorRef.current = extractor;
        });
      })
      .catch(() => {});

    // (3)/(4) Инициализация трекинга аргументов — до начала цикла проверки.
    try {
      const initial = await initializeArgumentTracking(projectId);
      setTrackedArguments(initial);
    } catch {
      setTrackedArguments([]);
    }

    // (1) Индикатор накала — непрерывный, чисто клиентский, без backend.
    const dataArray = new Float32Array(2048);
    volumeIntervalRef.current = setInterval(() => {
      const analyser = captureHandle.getAnalyser();
      if (!analyser) return;
      analyser.getFloatTimeDomainData(dataArray);
      const rmsDb = computeRmsDb(dataArray);
      volumeWindowsRef.current.push({ rmsDb, timestamp: Date.now() });
      if (volumeWindowsRef.current.length > 60) volumeWindowsRef.current.shift();

      // Пункт 87 — тот же тик, что уже используется для громкости,
      // переиспользован для накопления сырых сэмплов под голосовое
      // сравнение "я/не я". Тот же массив данных, не второй захват.
      rawSamplesBufferRef.current.push(new Float32Array(dataArray));
      if (rawSamplesBufferRef.current.length > 20) rawSamplesBufferRef.current.shift(); // ~10с хвост

      const state = categorizeEscalation(volumeWindowsRef.current);
      if (state) {
        setCategory(state.category);
        // Пункт 85 — логируем только РЕАЛЬНЫЙ переход, не каждый замер.
        if (state.category !== lastLoggedCategoryRef.current && sessionIdRef.current) {
          lastLoggedCategoryRef.current = state.category;
          logEscalationCategory(projectId, sessionIdRef.current, state.category).catch(() => {
            // Тихий сбой логирования не должен ломать сам индикатор — метрика статистики не критична для текущей сессии.
          });
        }
      }
    }, SAMPLE_INTERVAL_MS);

    // (2) Live-детектор уловок — требует транскрипции, тот же токен-механизм, что Live Hints.
    let token: string;
    try {
      const result = await mintTranscriptionToken();
      token = result.token;
    } catch {
      // Индикатор накала продолжает работать даже без транскрипции —
      // детектор уловок и трекинг аргументов просто не запускаются, не ломают всю сессию.
      return;
    }

    const audioContextForStream = captureHandle.getAudioContext();
    const transcriptionStream = captureHandle.getStream();
    if (!audioContextForStream || !transcriptionStream) return;

    transcriptionHandleRef.current = connectLiveTranscription(
      token,
      audioContextForStream,
      transcriptionStream,
      handleTranscript,
      () => {}, // ошибка транскрипции не должна ронять индикатор накала — молча продолжаем без остальных слоёв
    );

    manipulationIntervalRef.current = setInterval(async () => {
      const transcriptWindow = getRecentTranscriptWindow();
      if (!transcriptWindow.trim()) return;

      try {
        const newFlags = await analyzeLiveManipulation(projectId, transcriptWindow);
        if (newFlags.length > 0) {
          setFlags((prev) => [...newFlags, ...prev]);
          haptic('light');
        }
      } catch {
        // Тихий сбой цикла не должен ломать саму сессию.
      }
    }, MANIPULATION_CYCLE_MS);

    // (5) Детектор прощупывания — "симметрично детектору уловок"
    // (buкально ТЗ), тот же 30-секундный цикл, отдельный от него.
    // Backend сам решает, показывать ли предупреждение (только при
    // repeatCount >= 2) — клиент просто добавляет то, что вернулось,
    // без дублирования уже показанных id (backend может повторно
    // вернуть ту же тему, если repeatCount вырос ещё раз).
    probingIntervalRef.current = setInterval(async () => {
      // Пункт 87 — только "не я", buкально смысл детектора прощупывания.
      // Остальные циклы (уловки, трекинг аргументов) намеренно НЕ
      // используют эту фильтрацию — там нужен весь разговор целиком.
      const transcriptWindow = getRecentTranscriptWindowExcludingSelf();
      if (!transcriptWindow.trim()) return;

      try {
        const newWarnings = await analyzeProbing(projectId, transcriptWindow);
        if (newWarnings.length > 0) {
          setProbingWarnings((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            for (const w of newWarnings) byId.set(w.id, w);
            return Array.from(byId.values());
          });
          haptic('light');
        }
      } catch {
        // Тихий сбой цикла не должен ломать саму сессию.
      }
    }, PROBING_CYCLE_MS);

    // (4) Трекинг аргументов — самопланирующийся цикл с частотой,
    // зависящей от накала (2), не единый фиксированный интервал.
    scheduleTrackingCheck();
  }

  async function handleGenerateBreakingQuestions() {
    const transcriptWindow = getRecentTranscriptWindow();
    if (!transcriptWindow.trim()) return;
    setGeneratingQuestions(true);
    try {
      const result = await generateBreakingQuestions(projectId, transcriptWindow);
      setBreakingQuestions(result);
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setGeneratingQuestions(false);
    }
  }

  function handleStop() {
    transcriptionHandleRef.current?.stop();
    transcriptionHandleRef.current = null;
    captureHandleRef.current?.stop();
    captureHandleRef.current = null;
    if (volumeIntervalRef.current) clearInterval(volumeIntervalRef.current);
    if (manipulationIntervalRef.current) clearInterval(manipulationIntervalRef.current);
    if (probingIntervalRef.current) clearInterval(probingIntervalRef.current);
    if (trackingTimeoutRef.current) clearTimeout(trackingTimeoutRef.current);
    setCategory(null);
  }

  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)}>
        🧪 Экран сопровождения (экспериментально)
      </button>
    );
  }

  return (
    <section className="assistance-screen">
      <p className="steelman-case__label">Экран сопровождения — экспериментально</p>
      <p className="conversations-section__hint">
        Индикатор накала — оценка модели на основе голосовых сигналов, не факт об эмоциях. Детектор уловок и трекинг
        аргументов работают циклами (трекинг — чаще при росте накала). Ничего не сохраняется и не передаётся, кроме
        уже посчитанных на устройстве метрик.
      </p>

      {category && (
        <div className={`assistance-screen__indicator assistance-screen__indicator--${category.toLowerCase()}`}>
          <strong>{CATEGORY_LABEL[category as EscalationCategory]}</strong>
        </div>
      )}

      {flags.length > 0 && (
        <div className="assistance-screen__flags">
          <p className="steelman-case__label">Уловки в речи (🟡 догадка ИИ)</p>
          <ul>
            {flags.map((f) => (
              <li key={f.id} className="assistance-screen__flag">
                <strong>{f.technique}</strong>
                {f.confidence !== null && <span className="conversations-section__hint"> (уверенность {(f.confidence * 100).toFixed(0)}%)</span>}
                <p>{f.description}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {probingWarnings.length > 0 && (
        <div className="assistance-screen__flags assistance-screen__flags--probing">
          <p className="steelman-case__label">Настойчивый интерес к теме (🟡 догадка ИИ)</p>
          <ul>
            {probingWarnings.map((w) => (
              <li key={w.id} className="assistance-screen__flag assistance-screen__flag--probing">
                <strong>{w.topicDescription}</strong>
                <span className="conversations-section__hint">
                  {' '}
                  — упомянуто {w.repeatCount} раз, уверенность {(w.confidence * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {trackedArguments.length > 0 && (
        <div className="assistance-screen__tracking">
          <p className="steelman-case__label">Аргументы</p>
          <ul>
            {trackedArguments.map((t) => (
              <li key={t.id} className={`assistance-screen__tracked-arg assistance-screen__tracked-arg--${t.status.toLowerCase()}`}>
                <span>{t.argument.text}</span>
                <span className="conversations-section__hint"> — {TRACKING_STATE_LABEL[t.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {breakingQuestions && (
        <div className="assistance-screen__questions">
          <p className="steelman-case__label">🟡 Вопросы (догадка ИИ)</p>
          <p><strong>Пробивающий:</strong> {breakingQuestions.breakingQuestion}</p>
          <p><strong>Компромиссный:</strong> {breakingQuestions.compromiseQuestion}</p>
        </div>
      )}

      {captureState === 'active' && (
        <button type="button" onClick={handleGenerateBreakingQuestions} disabled={generatingQuestions}>
          {generatingQuestions ? 'Составляем…' : '💡 Предложить вопросы'}
        </button>
      )}

      {needsAudioConsent && (
        <ThirdPartyAudioConsentPrompt source="assistance-screen" onGranted={() => { setNeedsAudioConsent(false); handleStart(); }} onCancel={() => setNeedsAudioConsent(false)} />
      )}
      {!needsAudioConsent && captureState === 'idle' && (
        <button type="button" onClick={handleStart}>
          Начать
        </button>
      )}
      {captureState === 'requesting' && <p className="conversations-section__hint">Запрашиваем доступ к микрофону…</p>}
      {captureState === 'active' && (
        <>
          <p className="conversations-section__hint">🎙 Слушаем…</p>
          <button type="button" onClick={handleStop}>
            Остановить
          </button>
        </>
      )}
      {captureState === 'error' && (
        <>
          <p className="generation-error">{captureError}</p>
          <button type="button" onClick={handleStart}>
            Попробовать снова
          </button>
        </>
      )}
      {captureState === 'stopped' && (
        <button type="button" onClick={handleStart}>
          Начать снова
        </button>
      )}
    </section>
  );
}
