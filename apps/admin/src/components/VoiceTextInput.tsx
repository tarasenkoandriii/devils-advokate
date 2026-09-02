'use client';

// Пункт [sandbox-voice] 2026-09-01 — голосовой ввод квиза в песочнице.
// ОБНОВЛЕНО Пунктом [voice-note-ru] 2026-09-01 после живого прогона:
// оператор говорил по-русски, а транскрипт выходил английским/ивритом.
// Причина не в аудио-конвейере: AssemblyAI Streaming v3 поддерживает
// 18 языков БЕЗ русского и украинского — мультиязычная модель честно
// галлюцинировала ближайшими знакомыми ей языками.
//
// Поэтому два транспорта под одним селектором языка:
// - en → живой стриминг как раньше, теперь с ПИНОМ языка
//   (language_codes=["en"]) — без пина модель угадывает язык по звуку;
// - ru/uk/auto → запись MediaRecorder'ом и синхронная async-транскрипция
//   короткой заметки (universal ru/uk поддерживает): текст приходит
//   один раз по кнопке «Стоп», не по мере речи — честная цена
//   отсутствия этих языков в стриминге, названная в подсказке.
// Аудио в обоих путях не проходит транзитом никуда, кроме AssemblyAI,
// и нигде не сохраняется (заметка — буфер в пределах одного запроса).
import { useEffect, useRef, useState } from 'react';
import { sandboxTranscriptionToken, sandboxVoiceNote } from '../lib/endpoints';
import { startLiveAudioCapture, LiveAudioCaptureHandle } from '../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle } from '../lib/live-transcription';

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

type VoiceLang = 'ru' | 'uk' | 'en' | 'auto';

const LANG_LABELS: Record<VoiceLang, string> = { ru: 'Русский', uk: 'Українська', en: 'English', auto: 'Автоопределение' };

// Пункт [stt-multi] 2026-09-02: живой стриминг доступен всем трём
// языкам. Раньше здесь стоял только 'en' — потому что у AssemblyAI нет
// ни русского, ни украинского ни в одной потоковой модели, и для них
// оставался лишь путь короткой заметки. Теперь ru/uk ведёт Soniox
// (переключение языка внутри фразы он тоже умеет), en — прежний
// провайдер. 'auto' остаётся на заметке: без выбранного языка честнее
// дать модели весь файл целиком, чем угадывать провайдера на лету.
const STREAMING_LANGS = new Set<VoiceLang>(['ru', 'uk', 'en']);

export function VoiceTextInput({ value, onChange, placeholder, disabled, rows = 3 }: Props) {
  const [lang, setLang] = useState<VoiceLang>('ru');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const captureRef = useRef<LiveAudioCaptureHandle | null>(null);
  const wsRef = useRef<LiveTranscriptionHandle | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Текст до начала записи — финальные фразы дописываются к нему,
  // partial-фразы показываются поверх и заменяются (как в TMA).
  const baseRef = useRef('');
  const langRef = useRef<VoiceLang>('ru');

  function stopCaptureOnly() {
    wsRef.current?.stop();
    wsRef.current = null;
    recorderRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    setRecording(false);
  }

  useEffect(() => () => stopCaptureOnly(), []);

  function stop() {
    // Для записи-заметки stop() инициирует распознавание через
    // recorder.onstop; для стриминга — просто закрывает поток.
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop(); // onstop сам вызовет stopCaptureOnly + распознавание
      return;
    }
    stopCaptureOnly();
  }

  async function start() {
    setVoiceError(null);
    baseRef.current = value;
    langRef.current = lang;
    const capture = await startLiveAudioCapture((state, msg) => {
      if (state === 'error') {
        setVoiceError(msg);
        setRecording(false);
      }
    });
    if (!capture) return;
    captureRef.current = capture;
    try {
      const stream = capture.getStream();
      if (!stream) throw new Error('Аудиопоток недоступен');

      if (STREAMING_LANGS.has(lang)) {
        // ── Живой стриминг (ru/uk/en): текст появляется по мере речи. ──
        const credentials = await sandboxTranscriptionToken(lang);
        const ctx = capture.getAudioContext();
        if (!ctx) throw new Error('Аудиоконтекст недоступен');
        let partial = '';
        wsRef.current = connectLiveTranscription(
          credentials,
          ctx,
          stream,
          (update) => {
            if (update.isFinal) {
              baseRef.current = `${baseRef.current} ${update.text}`.trim();
              partial = '';
              onChange(baseRef.current);
            } else {
              partial = update.text;
              onChange(`${baseRef.current} ${partial}`.trim());
            }
          },
          (message) => {
            setVoiceError(message);
            stopCaptureOnly();
          },
          // Пункт [stt-multi] 2026-09-02: язык уже задан при выдаче
          // реквизитов (он же выбрал провайдера). Параметр URL остаётся
          // только для ветки AssemblyAI и игнорируется у Soniox.
          { languageCodes: [lang] },
        );
      } else {
        // ── Запись-заметка (ru/uk/auto): распознавание по «Стоп». ──
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          stopCaptureOnly();
          void transcribeNote(blob);
        };
        recorderRef.current = recorder;
        recorder.start(1000);
      }
      setRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Голосовой ввод недоступен';
      setVoiceError(
        /согласи|THIRD_PARTY|403|Forbidden/i.test(message)
          ? 'Нужно согласие на передачу аудио — нажмите «Выдать согласия» в чеклисте готовности'
          : message,
      );
      stopCaptureOnly();
    }
  }

  async function transcribeNote(blob: Blob) {
    setTranscribing(true);
    setVoiceError(null);
    try {
      const buffer = await blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const base64 = btoa(binary);
      const chosen = langRef.current;
      const { text } = await sandboxVoiceNote(base64, chosen === 'auto' ? undefined : chosen);
      if (text.trim()) {
        baseRef.current = `${baseRef.current} ${text.trim()}`.trim();
        onChange(baseRef.current);
      } else {
        setVoiceError('Речь не распознана — попробуйте ещё раз ближе к микрофону');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Распознавание не удалось';
      setVoiceError(
        /согласи|THIRD_PARTY|403|Forbidden/i.test(message)
          ? 'Нужно согласие на передачу аудио — нажмите «Выдать согласия» в чеклисте готовности'
          : message,
      );
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <div>
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <select value={lang} onChange={(e) => setLang(e.target.value as VoiceLang)} disabled={disabled || recording || transcribing} title="Язык распознавания">
          {(Object.keys(LANG_LABELS) as VoiceLang[]).map((l) => (
            <option key={l} value={l}>{LANG_LABELS[l]}</option>
          ))}
        </select>
        <button type="button" disabled={disabled || transcribing} onClick={recording ? stop : start}>
          {recording ? '■ Стоп' : '🎤 Голосом'}
        </button>
        {recording && STREAMING_LANGS.has(langRef.current) && (
          <span className="muted" style={{ fontSize: 12 }}>Говорите — текст появится в поле по мере речи</span>
        )}
        {recording && !STREAMING_LANGS.has(langRef.current) && (
          <span className="muted" style={{ fontSize: 12 }}>
            Идёт запись — текст появится после «Стоп» (русский/украинский живой стриминг не поддерживает, распознаём записью)
          </span>
        )}
        {transcribing && <span className="muted" style={{ fontSize: 12 }}>Распознаём запись…</span>}
        {voiceError && <span className="muted" style={{ fontSize: 12, color: 'var(--signal-critical)' }}>{voiceError} — можно набрать текстом</span>}
      </div>
    </div>
  );
}
