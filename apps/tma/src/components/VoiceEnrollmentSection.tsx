'use client';

// Пункт 87 → TMA UI: регистрация голосового отпечатка при онбординге.
// Тот же паттерн записи, что UserVoiceRecordingSection.tsx (Пункт 71,
// суфлёр) — MediaRecorder + decodeToRawAudio() для получения сырых
// сэмплов, дальше извлечение эмбеддинга через WASM (Пункт 87,
// voice-embedding.ts) и отправка ТОЛЬКО вектора на backend.
//
// НАМЕРЕННО ЭКСПЕРИМЕНТАЛЬНАЯ, НЕОБЯЗАТЕЛЬНАЯ СЕКЦИЯ — та же явная
// маркировка, что у всех live-фич проекта (Пункты 81-86). Без
// регистрации детектор прощупывания просто продолжает работать без
// автоматической фильтрации "я/не я" — эта секция не блокирует
// остальной онбординг.

import { useRef, useState } from 'react';
import { decodeToRawAudio } from '../lib/audio-post-process';
import {
  loadVoiceEmbeddingExtractor,
  embeddingToArray,
  voiceEmbeddingAvailability,
  enrollmentStep,
  expandStep,
} from '../lib/voice-embedding';
import { enrollVoiceEmbedding, getVoiceEnrollmentStatus, revokeVoiceEmbedding, listConsents, hasConsent } from '../lib/features';
import { VoiceBiometricConsentPrompt } from './VoiceBiometricConsentPrompt';
import { haptic } from '../lib/telegram';
import { reportFailure } from '../lib/failure-report';

// Путь к .onnx-модели эмбеддинга — должен быть выложен статически в
// TMA (см. ссылку на релиз sherpa-onnx в /TODO.md). Не проверено в
// этой среде разработки — нет сети для скачивания самой модели.
const EMBEDDING_MODEL_URL = '/models/speaker-embedding.onnx';

type EnrollmentState =
  | 'idle'
  | 'checking'
  | 'need-consent'
  | 'recording'
  | 'processing'
  | 'enrolled'
  | 'error'
  // Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26: продукт
  // не может посчитать отпечаток в этой сборке — и говорит это ДО того,
  // как спросить биометрическое согласие и включить микрофон.
  | 'unavailable';

/** Состояние вместе со своим текстом. Разошлись бы они молча, если
 * держать их в отдельных переменных, — именно это и пережило первую
 * версию проверок. */
export type EnrollmentView =
  | { state: Exclude<EnrollmentState, 'unavailable' | 'error'> }
  | { state: 'unavailable'; why: string }
  | { state: 'error'; message: string };

/** Честный текст вместо кнопки, которая не может сработать.
 *
 * Отдельным компонентом, чтобы проверка его РИСОВАЛА: утверждение
 * «согласия не просим и не записываем» — о разметке, и проверять его
 * чтением исходника было бы тем же дефектом, о котором весь пункт. */
export function VoiceEnrollmentUnavailable({ why }: { why: string }) {
  return (
    <>
      <p role="alert" className="conversations-section__hint">
        Сейчас не работает: {why}. Поэтому согласие на биометрию не спрашиваем и запись не делаем —
        собирать образец голоса под возможность, которой нет, продукт не будет.
      </p>
      <p className="conversations-section__hint">
        Без отпечатка разбор работает как обычно: он просто не делит речь на «вы» и «собеседник»
        автоматически.
      </p>
    </>
  );
}

/** Разметка раздела по состоянию — чистая функция состояния.
 *
 * Отдельно от состояния и от обработчиков намеренно. Две мутации
 * пережили первую версию проверок: «убрать честный текст о
 * недоступности с экрана» и «игнорировать проверку возможности при
 * открытии». Обе — про МЕСТО ПРИМЕНЕНИЯ правила, а проверялось само
 * правило: чистая функция и отдельный компонент текста. Ровно та
 * ошибка, которую этот проект уже называл несколько раз. Теперь
 * разметка рисуется в проверке по каждому состоянию, а решения —
 * `expandStep` и `enrollmentStep` — вызываются напрямую.
 */
export function EnrollmentBody({
  view,
  onStartRecording,
  onRevoke,
  onConsentGranted,
  onConsentCancel,
}: {
  view: EnrollmentView;
  onStartRecording: () => void;
  onRevoke: () => void;
  onConsentGranted: () => void;
  onConsentCancel: () => void;
}) {
  return (
    <section className="voice-enrollment-section">
        <p className="steelman-case__label">Голосовой отпечаток</p>
  
        {view.state === 'checking' && <p className="conversations-section__hint">Проверяем…</p>}
  
        {view.state === 'unavailable' && <VoiceEnrollmentUnavailable why={view.why} />}
  
        {view.state === 'need-consent' && (
          <VoiceBiometricConsentPrompt onGranted={onConsentGranted} onCancel={onConsentCancel} />
        )}
  
        {view.state === 'idle' && (
          <>
            <p className="conversations-section__hint">
              Не зарегистрирован. Приложение сможет автоматически отличать вас от собеседника во время живых сессий.
            </p>
            <button type="button" onClick={onStartRecording}>
              Записать образец голоса
            </button>
          </>
        )}
  
        {view.state === 'recording' && <p className="conversations-section__hint">🎙 Говорите — например, назовите своё имя… (5 секунд)</p>}
        {view.state === 'processing' && <p className="conversations-section__hint">Обрабатываем запись…</p>}
  
        {view.state === 'enrolled' && (
          <>
            <p className="conversations-section__hint">✅ Голосовой отпечаток зарегистрирован.</p>
            <button type="button" onClick={onRevoke}>
              Отозвать
            </button>
          </>
        )}
  
        {view.state === 'error' && (
          <>
            <p role="alert" className="generation-error">{view.message}</p>
            <button type="button" onClick={onStartRecording}>
              Попробовать снова
            </button>
          </>
        )}
      </section>
  );
}

export function VoiceEnrollmentSection() {
  const [expanded, setExpanded] = useState(false);
  // Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26: одно
  // состояние вместе со своим текстом, а не три переменные рядом.
  // Мутация «потерять причину недоступности по дороге к экрану» не
  // ловилась ничем, и правильный ответ на такой шов — убрать шов, а не
  // проверять его: теперь причину нельзя не передать, её носит само
  // состояние.
  const [view, setView] = useState<EnrollmentView>({ state: 'idle' });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);


  async function handleExpand() {
    setExpanded(true);
    setView({ state: 'checking' });
    // Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26:
    // возможность проверяется ПЕРВОЙ, до всего остального. Раньше
    // «уже зарегистрирован» и кнопка записи показывались, а о том, что
    // посчитать отпечаток нечем, человек узнавал после пяти секунд
    // записи своего голоса и выданного биометрического согласия.
    const next = await expandStep({
      availability: () => voiceEmbeddingAvailability(EMBEDDING_MODEL_URL),
      status: getVoiceEnrollmentStatus,
    });
    setView(next);
  }

  async function handleStartRecording() {
    // Порядок — суть пункта: сначала узнать, может ли продукт посчитать
    // отпечаток, и только потом спрашивать согласие и включать микрофон.
    // "Один экран согласия... не разрозненные пуш-запросы" — тот же
    // принцип, что у геолокации (Пункт 77), но отдельный тип согласия.
    const next = await enrollmentStep({
      availability: () => voiceEmbeddingAvailability(EMBEDDING_MODEL_URL),
      hasBiometricConsent: async () => hasConsent(await listConsents().catch(() => []), 'VOICE_BIOMETRIC'),
    });
    if (next.step === 'unavailable') {
      setView({ state: 'unavailable', why: next.why });
      return;
    }
    if (next.step === 'need-consent') {
      setView({ state: 'need-consent' });
      return;
    }
    await beginRecording();
  }

  async function beginRecording() {
    if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
      setView({ state: 'error', message: 'Микрофон недоступен в этом браузере/приложении' });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setView({ state: 'error', message: 'Доступ к микрофону не предоставлен' });
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void processRecording();
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setView({ state: 'recording' });

    // Короткий образец достаточен для эмбеддинга — не нужна длинная запись.
    setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    }, 5000);
  }

  async function processRecording() {
    setView({ state: 'processing' });
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const raw = await decodeToRawAudio(blob);

      const extractor = await loadVoiceEmbeddingExtractor(EMBEDDING_MODEL_URL);
      if (!extractor) {
        setView({ state: 'error', message: 'Не удалось загрузить модуль извлечения голосового отпечатка' });
        return;
      }

      const embedding = extractor.extractEmbedding(raw.channels[0], raw.sampleRate);
      if (!embedding) {
        setView({ state: 'error', message: 'Не удалось извлечь отпечаток — попробуйте записать образец подлиннее' });
        return;
      }

      await enrollVoiceEmbedding(embeddingToArray(embedding));
      setView({ state: 'enrolled' });
      haptic('success');
    } catch {
      setView({ state: 'error', message: 'Не удалось обработать запись' });
      haptic('error');
    }
  }

  async function handleRevoke() {
    try {
      await revokeVoiceEmbedding();
      setView({ state: 'idle' });
      haptic('light');
    } catch (err) {
      reportFailure(err, 'Не удалось удалить голосовой отпечаток');
    }
  }

  if (!expanded) {
    return (
      <button type="button" onClick={handleExpand}>
        🧪 Голосовой отпечаток (экспериментально)
      </button>
    );
  }

  return (
    <EnrollmentBody
      view={view}
      onStartRecording={() => void handleStartRecording()}
      onRevoke={() => void handleRevoke()}
      onConsentGranted={() => void beginRecording()}
      onConsentCancel={() => setView({ state: 'idle' })}
    />
  );
}
