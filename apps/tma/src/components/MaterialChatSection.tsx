'use client';

// Пункт 91 (backend) → TMA UI: голосовой чат с AI для критики
// материалов (§3.27 ТЗ). Тот же архитектурный образец, что
// SparringSection.tsx (Пункт 69/90) — многоходовой диалог + голосовой
// ввод/вывод — но НАМЕРЕННО ОТДЕЛЬНЫЙ, более простой компонент, не
// его копия: здесь нет выбора архетипа/персоны (AI — совместный
// помощник, не роль), зато есть отображение и использование
// refinedEditPrompt, которого у спарринга нет вообще.
//
// АВТОВОСПРОИЗВЕДЕНИЕ АУДИО — та же дисциплина, что уже была найдена
// и исправлена в SparringSection.tsx (Пункт 90): различаем "сессия
// только что стартовала/резюмирована" (не играть последнее сообщение
// повторно) от "сессия выросла новым сообщением" (играть).

import { useEffect, useRef, useState } from 'react';
import {
  startMaterialChatSession,
  listMaterialChatSessions,
  getMaterialChatSession,
  replyMaterialChat,
  endMaterialChatSession,
  uploadMaterialChatVoiceReply,
  submitMaterialChatVoiceReply,
  getMaterialChatVoiceReplyStatus,
} from '../lib/features';
import { MaterialChatSession, MaterialChatVoiceReplyJob } from '../lib/types';
import { haptic } from '../lib/telegram';

interface MaterialChatSectionProps {
  projectId: string;
  workingMaterialId: string;
}

export function MaterialChatSection({ projectId, workingMaterialId }: MaterialChatSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [sessions, setSessions] = useState<MaterialChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<MaterialChatSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'uploading' | 'transcribing'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Та же дисциплина автовоспроизведения, что SparringSection.tsx (Пункт 90).
  const lastPlayedMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const messages = activeSession?.messages ?? [];
    // Проверка `!activeSession` убрана как избыточная (аудит 2026-09-01):
    // непустой messages уже означает, что сессия есть. Ссылка на
    // activeSession целиком заставляла exhaustive-deps требовать его в
    // зависимостях — ровно то, что раньше подавлялось директивой.
    // Повтор озвучки по-прежнему отсекает lastPlayedMessageIdRef.
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'ASSISTANT') return;
    if (last.id === lastPlayedMessageIdRef.current) return;
    lastPlayedMessageIdRef.current = last.id;
    if (last.audioBase64) {
      new Audio(`data:audio/mpeg;base64,${last.audioBase64}`).play().catch(() => {
        // Автовоспроизведение заблокировано браузером до первого взаимодействия — не критично, текст остаётся видимым.
      });
    }
  }, [activeSession?.messages, activeSession?.id]);

  async function loadSessions() {
    try {
      setSessions(await listMaterialChatSessions(projectId, workingMaterialId));
    } catch {
      setSessions([]);
    }
  }

  async function handleExpand() {
    setExpanded(true);
    await loadSessions();
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const session = await startMaterialChatSession(projectId, workingMaterialId);
      setActiveSession(session);
      // Свежесозданная сессия — открывающая реплика ещё не звучала, эффект должен её проиграть.
      lastPlayedMessageIdRef.current = null;
      await loadSessions();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось начать чат');
    } finally {
      setStarting(false);
    }
  }

  async function handleOpenSession(sessionId: string) {
    try {
      const full = await getMaterialChatSession(sessionId);
      setActiveSession(full);
      // Резюмирование — последнее сообщение могло звучать раньше, не проигрываем повторно.
      const existing = full.messages ?? [];
      lastPlayedMessageIdRef.current = existing.length > 0 ? existing[existing.length - 1].id : null;
    } catch {
      haptic('error');
    }
  }

  async function handleReply() {
    if (!activeSession || !replyText.trim()) return;
    setSending(true);
    setError(null);
    try {
      const newMessages = await replyMaterialChat(activeSession.id, replyText.trim());
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
      const ended = await endMaterialChatSession(activeSession.id);
      setActiveSession((prev) => (prev ? { ...prev, status: ended.status, endedAt: ended.endedAt } : prev));
      await loadSessions();
    } catch {
      haptic('error');
    }
  }

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
      const { audioUrl } = await uploadMaterialChatVoiceReply(activeSession.id, file);
      const job = await submitMaterialChatVoiceReply(activeSession.id, audioUrl);
      setVoiceStatus('transcribing');
      pollVoiceReplyStatus(activeSession.id, job.id);
    } catch (err) {
      haptic('error');
      setVoiceStatus('idle');
      setError(err instanceof Error ? err.message : 'Не удалось отправить голосовую реплику');
    }
  }

  function pollVoiceReplyStatus(sessionId: string, jobId: string) {
    async function check() {
      let job: MaterialChatVoiceReplyJob;
      try {
        job = await getMaterialChatVoiceReplyStatus(sessionId, jobId);
      } catch {
        setVoiceStatus('idle');
        haptic('error');
        return;
      }
      if (job.status === 'PENDING') {
        pollTimeoutRef.current = setTimeout(check, 2000);
        return;
      }
      if (job.status === 'FAILED') {
        setVoiceStatus('idle');
        haptic('error');
        setError(job.errorMessage ?? 'Не удалось распознать голос');
        return;
      }
      try {
        const full = await getMaterialChatSession(sessionId);
        setActiveSession(full);
        haptic('success');
      } catch {
        haptic('error');
      } finally {
        setVoiceStatus('idle');
      }
    }
    void check();
  }

  if (!expanded) {
    return (
      <button type="button" onClick={handleExpand}>
        🧪 Голосовой чат с AI (уточнить промпт на правки)
      </button>
    );
  }

  return (
    <section className="material-chat-section">
      <p className="steelman-case__label">Голосовой чат — уточнение промпта на правки</p>
      <p className="conversations-section__hint">
        AI — совместный помощник, не оппонент: задаёт уточняющие вопросы, помогает довести промпт на правки до
        конкретного вида. Первоисточник материала не передаётся — только уже сохранённые критика и текущий промпт.
      </p>

      {!activeSession && (
        <>
          {sessions.length > 0 && (
            <ul className="material-chat-section__sessions">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => handleOpenSession(s.id)}>
                    Сессия от {new Date(s.createdAt).toLocaleString()} ({s.status === 'ACTIVE' ? 'активна' : 'завершена'})
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={handleStart} disabled={starting}>
            {starting ? 'Начинаем…' : 'Начать новый чат'}
          </button>
        </>
      )}

      {activeSession && (
        <>
          <button type="button" onClick={() => setActiveSession(null)}>
            ← К списку сессий
          </button>

          {activeSession.refinedEditPrompt && (
            <div className="material-chat-section__refined-prompt">
              <p className="steelman-case__label">Текущий уточнённый промпт</p>
              <p>{activeSession.refinedEditPrompt}</p>
            </div>
          )}

          <ul className="sparring-chat">
            {(activeSession.messages ?? []).map((m) => (
              <li key={m.id} className={`sparring-chat__message sparring-chat__message--${m.role.toLowerCase()}`}>
                <span className="sparring-chat__role">{m.role === 'ASSISTANT' ? 'Помощник' : 'Вы'}</span>
                <span>{m.text}</span>
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
                    placeholder="Ваш ответ…"
                    disabled={sending || recording}
                  />
                  <div className="conversations-section__add-actions">
                    <button type="button" onClick={handleReply} disabled={sending || recording || !replyText.trim()}>
                      {sending ? 'Отправляем…' : 'Отправить'}
                    </button>
                    {!recording ? (
                      <button type="button" onClick={handleStartRecording} disabled={sending}>
                        🎙 Записать голосом
                      </button>
                    ) : (
                      <button type="button" onClick={handleStopRecording}>
                        ⏹ Остановить запись
                      </button>
                    )}
                    <button type="button" onClick={handleEnd} disabled={sending || recording}>
                      Завершить чат
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="conversations-section__hint">Чат завершён.</p>
          )}
        </>
      )}
    </section>
  );
}
