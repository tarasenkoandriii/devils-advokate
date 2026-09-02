'use client';

// Пункт 55 (backend) → TMA UI: Sparring / Red Team (§3.1 ТЗ), пункт 34
// v3-роадмапа. Единственный компонент этого захода с реальным
// многоходовым чат-интерфейсом — все остальные фичи одноразовые
// (генерация → результат), здесь — список сообщений + поле ввода,
// как настоящий диалог.
//
// Пункт 69 (backend) → расширен архетипами и голосовым вводом (§3.26
// ТЗ). Голосовой ввод — ЧЕСТНАЯ, НЕ СКРЫТАЯ задержка (запись →
// загрузка → ожидание транскрибации → авто-отправка как обычная
// реплика), не имитация мгновенности.
//
// Пункт 90 (backend) → голосовой ВЫВОД реплик оппонента и
// предзаготовка (§3.26 ТЗ). Аудио теперь предзаготовлено сервером
// (m.audioBase64) и АВТОВОСПРОИЗВОДИТСЯ, не по клику — "тренировка
// была ближе к ощущению реального разговора" (buкально ТЗ). Ранее
// использованный здесь SpeakButton (Пункт 63, отдельный сетевой
// вызов синтеза при клике) остался честным ручным fallback'ом на
// случай сбоя предзаготовки, не основным путём — см. useEffect ниже.

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  endSparringSession,
  getSparringSession,
  getSparringVoiceReplyStatus,
  listPeople,
  listSparringSessions,
  replySparring,
  startSparringSession,
  submitSparringVoiceReply,
  uploadSparringVoiceReply,
} from '../lib/features';
import { ArchetypeType, ProjectPersonLink, SparringSession, SparringVoiceReplyJob } from '../lib/types';
import { haptic } from '../lib/telegram';
import { SpeakButton } from './SpeakButton';
import { CompromiseSheetSection } from './CompromiseSheetSection';

/** Потолок опроса статуса голосовой реплики (аудит 2026-09-02). */
const VOICE_REPLY_POLL_MAX_MS = 3 * 60 * 1000;

interface SparringSectionProps {
  projectId: string;
}

// Та же дисциплина, что уже применена в ArchetypePerspectivesSection.tsx
// (не экспортирована оттуда — низкорисковое дублирование константы,
// не метода, тот же принцип, что применялся на backend для
// ARCHETYPE_DESCRIPTIONS).
const ARCHETYPE_LABELS: Record<ArchetypeType, string> = {
  POLICE_OFFICER: 'Полицейский (законность)',
  LAWYER: 'Юрист (юридические риски)',
  NEIGHBORHOOD_GRANDMOTHER: 'Бабушка у подъезда (репутация)',
  FINANCIAL_ANALYST: 'Финансовый аналитик',
  PSYCHOLOGIST: 'Психолог',
  CHILD: 'Ребёнок (наивный вопрос)',
  JEALOUS_SPOUSE: 'Ревнивая жена (враждебная трактовка)',
  TROUBLEMAKER: 'Скандалист (враждебная трактовка)',
  CUSTOM: 'Свой архетип…',
  REAL_PERSON: 'Реальный человек из проекта…',
};

export function SparringSection({ projectId }: SparringSectionProps) {
  const [sessions, setSessions] = useState<SparringSession[]>([]);
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState<SparringSession | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState('');
  const [selectedArchetype, setSelectedArchetype] = useState<ArchetypeType | ''>('');
  const [customArchetype, setCustomArchetype] = useState('');
  const [starting, setStarting] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'uploading' | 'transcribing'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Пункт 90 (§3.26 ТЗ) — id последней реально воспроизведённой
  // реплики оппонента, чтобы не переигрывать звук при каждом ре-рендере
  // и не автовоспроизводить старые сообщения при первой загрузке уже
  // существующей сессии (только НОВЫЕ реплики, появившиеся после того,
  // как пользователь уже находится в диалоге).
  const lastPlayedMessageIdRef = useRef<string | null>(null);
  // Отдельно от lastPlayedMessageIdRef — какой sessionId уже был
  // "инициализирован" (первая загрузка/резюме сессии), чтобы отличить
  // "только что открыли сессию с уже существующей историей" (НЕ играть
  // последнее сообщение — пользователь мог уже слышать его раньше) от
  // "сессия выросла новым сообщением, пока пользователь уже в диалоге"
  // (играть).
  const initializedSessionIdRef = useRef<string | null>(null);

  const reload = useCallback(() => {
    return listSparringSessions(projectId)
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [projectId]);

  // Пункт 90 (§3.26 ТЗ) — "реплики AI-собеседника озвучиваются
  // голосом" (buкально ТЗ), автоматически, не по клику — "тренировка
  // была ближе к ощущению реального разговора". Играет ТОЛЬКО самую
  // новую реплику оппонента, только если она реально ещё не звучала
  // в этой сессии компонента (lastPlayedMessageIdRef).
  useEffect(() => {
    const messages = activeSession?.messages ?? [];
    // Проверка `!activeSession` убрана как избыточная (аудит 2026-09-01):
    // непустой messages уже означает, что сессия есть. Ссылка на
    // activeSession целиком заставляла exhaustive-deps требовать его в
    // зависимостях — ровно то, что раньше подавлялось директивой.
    // Повтор озвучки по-прежнему отсекает lastPlayedMessageIdRef.
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];

    if (last.role !== 'OPPONENT') return;
    if (last.id === lastPlayedMessageIdRef.current) return;
    lastPlayedMessageIdRef.current = last.id;
    if (last.audioBase64) {
      new Audio(`data:audio/mpeg;base64,${last.audioBase64}`).play().catch(() => {
        // Автовоспроизведение могло быть заблокировано браузером до первого
        // взаимодействия пользователя со страницей — не критично, кнопка
        // озвучки (SpeakButton, honest fallback) остаётся доступна вручную.
      });
    }
  }, [activeSession?.messages, activeSession?.id]);

  useEffect(() => {
    void Promise.all([reload(), listPeople(projectId).then(setPeople).catch(() => setPeople([]))]).finally(() =>
      setLoading(false),
    );
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, [reload, projectId]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const session = await startSparringSession(
        projectId,
        selectedPersonId || undefined,
        selectedArchetype || undefined,
        selectedArchetype === 'CUSTOM' ? customArchetype.trim() : undefined,
      );
      setActiveSession(session);
      // Пункт 90 — свежесозданная сессия: открывающая реплика ЕЩЁ НЕ
      // звучала, эффект автовоспроизведения должен её проиграть.
      initializedSessionIdRef.current = session.id;
      lastPlayedMessageIdRef.current = null;
      await reload();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось начать спарринг');
    } finally {
      setStarting(false);
    }
  }

  async function handleOpenSession(sessionId: string) {
    try {
      const full = await getSparringSession(sessionId);
      setActiveSession(full);
      // Пункт 90 — резюмирование уже существующей сессии: последнее
      // сообщение могло звучать в прошлый раз, честно НЕ проигрываем
      // его повторно — только будущие НОВЫЕ реплики.
      initializedSessionIdRef.current = full.id;
      const existingMessages = full.messages ?? [];
      lastPlayedMessageIdRef.current = existingMessages.length > 0 ? existingMessages[existingMessages.length - 1].id : null;
    } catch {
      haptic('error');
    }
  }

  async function handleReply() {
    if (!activeSession || !replyText.trim()) return;
    setSending(true);
    setError(null);
    try {
      const newMessages = await replySparring(activeSession.id, replyText.trim());
      setActiveSession((prev) => (prev ? { ...prev, messages: [...(prev.messages ?? []), ...newMessages] } : prev));
      setReplyText('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось отправить ответ');
    } finally {
      setSending(false);
    }
  }

  async function handleEnd() {
    if (!activeSession) return;
    try {
      const ended = await endSparringSession(activeSession.id);
      setActiveSession((prev) => (prev ? { ...prev, status: ended.status, endedAt: ended.endedAt } : prev));
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  // Пункт 69 — голосовой ввод. Честная, видимая последовательность
  // состояний: запись → "Загружаем…" → "Распознаём голос…" (поллинг) →
  // автоматическая отправка как обычная реплика.
  async function handleStartRecording() {
    if (!('mediaDevices' in navigator)) {
      setError('Запись голоса недоступна в этом браузере/приложении');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Доступ к микрофону не предоставлен');
    }
  }

  function handleStopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !activeSession) return;
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const file = new File([blob], 'voice-reply.webm', { type: 'audio/webm' });
      await handleVoiceReplySubmit(file);
    };
    recorder.stop();
    setRecording(false);
  }

  async function handleVoiceReplySubmit(file: File) {
    if (!activeSession) return;
    setVoiceStatus('uploading');
    setError(null);
    try {
      // Пункт [stt-multi] 2026-09-02: провайдер, принявший байты,
      // передаётся дальше вместе с задачей.
      const { audioUrl, sttProvider } = await uploadSparringVoiceReply(activeSession.id, file);
      const job = await submitSparringVoiceReply(activeSession.id, audioUrl, sttProvider);
      setVoiceStatus('transcribing');
      pollVoiceReplyStatus(activeSession.id, job.id);
    } catch (err) {
      haptic('error');
      setVoiceStatus('idle');
      setError(err instanceof Error ? err.message : 'Не удалось отправить голосовую реплику');
    }
  }

  function pollVoiceReplyStatus(sessionId: string, jobId: string) {
    const startedAt = Date.now();
    async function check() {
      let job: SparringVoiceReplyJob;
      try {
        job = await getSparringVoiceReplyStatus(sessionId, jobId);
      } catch {
        setVoiceStatus('idle');
        haptic('error');
        return;
      }
      if (job.status === 'PENDING' || job.status === 'PROCESSING') {
        // Аудит 2026-09-02: потолок ожидания. Без него клиент опрашивал
        // статус бесконечно, если вебхук провайдера так и не пришёл;
        // серверная сторожевая переведёт джобу в FAILED позже (30 мин),
        // но держать человека у «…» столько нельзя — через три минуты
        // говорим прямо и даём записать заново.
        if (Date.now() - startedAt > VOICE_REPLY_POLL_MAX_MS) {
          setVoiceStatus('idle');
          haptic('error');
          setError('Распознавание заняло слишком долго — попробуйте записать реплику ещё раз');
          return;
        }
        pollTimeoutRef.current = setTimeout(check, 2000);
        return;
      }
      if (job.status === 'FAILED') {
        setVoiceStatus('idle');
        haptic('error');
        setError(job.errorMessage ?? 'Не удалось распознать голос');
        return;
      }
      // COMPLETED — реплика и ответ оппонента уже созданы на сервере,
      // перезагружаем сессию, чтобы получить их.
      try {
        const full = await getSparringSession(sessionId);
        setActiveSession(full);
        haptic('success');
      } finally {
        setVoiceStatus('idle');
      }
    }
    void check();
  }

  if (loading) return null;

  if (activeSession) {
    return (
      <section className="sparring-section">
        <button type="button" onClick={() => setActiveSession(null)}>
          ← К списку сессий
        </button>
        <h3>
          Спарринг{' '}
          {(() => {
            const archetype: ArchetypeType | null = activeSession.archetypeType;
            if (archetype) {
              return `(${archetype === 'CUSTOM' ? activeSession.customArchetypeDescription : ARCHETYPE_LABELS[archetype]})`;
            }
            if (activeSession.targetPerson) {
              return `с оппонентом «${activeSession.targetPerson.displayName ?? 'без имени'}»`;
            }
            return '';
          })()}
        </h3>
        <p className="conversations-section__hint">
          AI играет роль оппонента для тренировки — это не поиск объективной истины, стресс-тест вашей позиции.
        </p>

        <ul className="sparring-chat">
          {(activeSession.messages ?? []).map((m) => (
            <li key={m.id} className={`sparring-chat__message sparring-chat__message--${m.role.toLowerCase()}`}>
              <span className="sparring-chat__role">{m.role === 'OPPONENT' ? 'Оппонент' : 'Вы'}</span>
              <span>{m.text}</span>
              {/* Пункт 90 — аудио уже автовоспроизводится (см. useEffect выше)
                  из предзаготовленного m.audioBase64, без отдельного
                  сетевого вызова. SpeakButton остаётся честным ручным
                  fallback'ом на случай, если синтез на backend не удался
                  (audioBase64 = null) или автовоспроизведение заблокировал
                  браузер — не основной путь, а запасной. */}
              {m.role === 'OPPONENT' && <SpeakButton text={m.text} />}
            </li>
          ))}
        </ul>

        {error && <p className="generation-error">{error}</p>}

        {activeSession.status === 'ACTIVE' ? (
          <div className="conversations-section__add">
            {voiceStatus !== 'idle' ? (
              <p className="conversations-section__hint">
                {voiceStatus === 'uploading' ? 'Загружаем запись…' : 'Распознаём голос — обычно занимает несколько секунд…'}
              </p>
            ) : (
              <>
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Ваш ответ оппоненту"
                />
                <div className="conversations-section__add-actions">
                  <button type="button" onClick={handleReply} disabled={sending || !replyText.trim()}>
                    {sending ? 'Отправляем…' : 'Ответить текстом'}
                  </button>
                  {!recording ? (
                    <button type="button" onClick={handleStartRecording}>
                      🎤 Ответить голосом
                    </button>
                  ) : (
                    <button type="button" onClick={handleStopRecording}>
                      ⏹ Остановить запись
                    </button>
                  )}
                  <button type="button" onClick={handleEnd}>
                    Завершить сессию
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="conversations-section__hint">Сессия завершена.</p>
        )}

        <CompromiseSheetSection
          sessionId={activeSession.id}
          projectId={projectId}
          hasDialogue={(activeSession.messages ?? []).length > 1}
        />
      </section>
    );
  }

  return (
    <section className="sparring-section">
      <h3>Спарринг с оппонентом (Red Team)</h3>
      <p className="conversations-section__hint">
        AI генерирует реалистичные возражения и тренирует вас отвечать на них — до реального разговора.
      </p>

      {sessions.length > 0 && (
        <ul className="sparring-session-list">
          {sessions.map((s) => (
            <li key={s.id} className="sparring-session-list__item">
              <button type="button" onClick={() => handleOpenSession(s.id)}>
                {(() => {
                  const archetype: ArchetypeType | null = s.archetypeType;
                  if (archetype) return ARCHETYPE_LABELS[archetype];
                  if (s.targetPerson) return `Оппонент: ${s.targetPerson.displayName ?? 'без имени'}`;
                  return 'Общий оппонент';
                })()}{' '}
                — {s.status === 'ACTIVE' ? 'активна' : 'завершена'} ({new Date(s.createdAt).toLocaleDateString('ru-RU')})
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="conversations-section__add">
        <label>
          Линия поведения оппонента
          <select value={selectedArchetype} onChange={(e) => setSelectedArchetype(e.target.value as ArchetypeType | '')}>
            <option value="">Общий оппонент</option>
            {(Object.keys(ARCHETYPE_LABELS) as ArchetypeType[])
              .filter((t) => t !== 'REAL_PERSON')
              .map((type) => (
                <option key={type} value={type}>
                  {ARCHETYPE_LABELS[type]}
                </option>
              ))}
          </select>
        </label>
        {selectedArchetype === 'CUSTOM' && (
          <label>
            Описание архетипа
            <input value={customArchetype} onChange={(e) => setCustomArchetype(e.target.value)} placeholder="Например: строгий начальник старой закалки" />
          </label>
        )}
        {people.length > 0 && (
          <label>
            Реальный человек из проекта (необязательно)
            <select
              value={selectedPersonId}
              onChange={(e) => {
                setSelectedPersonId(e.target.value);
                if (e.target.value) setSelectedArchetype('REAL_PERSON');
              }}
            >
              <option value="">— не выбран —</option>
              {people.map((p) => (
                <option key={p.personId} value={p.personId}>
                  {p.person.displayName ?? 'Без имени'}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleStart} disabled={starting}>
            {starting ? 'Начинаем…' : 'Начать спарринг'}
          </button>
        </div>
      </div>
    </section>
  );
}
