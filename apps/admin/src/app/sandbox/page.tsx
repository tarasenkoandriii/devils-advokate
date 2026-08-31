'use client';

// Пункт [admin-sandbox] 2026-08-31 — песочница оператора.
//
// Одна страница = одна цепочка YouTube-разбора, по шагам сверху вниз:
// готовность конфигурации → поиск (шаг 1) → прогон транскрибации
// (шаги 4–7) → анализ (шаг 8). Порядок на странице повторяет порядок
// шагов намеренно: если что-то красное в чек-листе, дальше можно не
// нажимать — и это видно без чтения документации.
//
// Всё выполняется от имени ВАШЕГО операторского аккаунта, с реальными
// ключами, реальной квотой YouTube (внизу счётчик не показывается —
// лимит общий 20/сутки на пользователя) и реальными счетами AssemblyAI/
// LLM. Песочница не обходит ни одной проверки — отказ по согласиям
// здесь означает, что и у пользователя откажет.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSandboxStatus,
  grantSandboxConsents,
  sandboxYouTubeSearch,
  runSandboxTranscription,
  getSandboxConversation,
  sandboxAnalyze,
  createSandboxUploadConversation,
  getSandboxUploadToken,
  confirmSandboxUpload,
  sandboxTranscribe,
} from '../../lib/endpoints';
import type {
  SandboxStatus,
  SandboxYouTubeSearch,
  SandboxTranscriptionRun,
  SandboxConversation,
} from '../../lib/types';

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'Неизвестная ошибка';
}

export default function SandboxPage() {
  // ── Чек-лист ──
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);

  const loadStatus = useCallback(() => {
    getSandboxStatus().then(setStatus).catch((e) => setStatusError(errText(e)));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  async function handleGrantConsents() {
    setGranting(true);
    try {
      await grantSandboxConsents();
      loadStatus();
    } catch (e) {
      setStatusError(errText(e));
    } finally {
      setGranting(false);
    }
  }

  // ── YouTube-поиск ──
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<SandboxYouTubeSearch | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      setSearch(await sandboxYouTubeSearch(query));
    } catch (e) {
      setSearch(null);
      setSearchError(errText(e));
    } finally {
      setSearching(false);
    }
  }

  // ── Прогон транскрибации ──
  const [run, setRun] = useState<SandboxTranscriptionRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [conversation, setConversation] = useState<SandboxConversation | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Поллинг, а не пуш: вебхук приходит на бэкенд, у админки нет канала
  // реального времени, и заводить его ради одной страницы — лишняя
  // инфраструктура. Раз в 5 секунд, останавливается на терминальном
  // статусе и при уходе со страницы.
  useEffect(() => {
    if (!run) return;
    const poll = () => {
      getSandboxConversation(run.conversationId)
        .then((c) => {
          setConversation(c);
          if (c.status !== 'TRANSCRIBING' && pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        })
        .catch(() => undefined);
    };
    poll();
    pollTimer.current = setInterval(poll, 5000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [run]);

  async function handleRun() {
    setRunning(true);
    setRunError(null);
    setConversation(null);
    try {
      setRun(await runSandboxTranscription());
    } catch (e) {
      setRun(null);
      setRunError(errText(e));
    } finally {
      setRunning(false);
    }
  }

  // ── Загрузка реального файла (вторая итерация 2026-08-31) ──
  // Тот же протокол прямой загрузки, что у TMA, но клиентскую половину
  // страница выполняет сама: токен берётся обычным admin-запросом (с
  // cookie), а байты уходят put()'ом напрямую в blob — SDK-шный
  // upload() не подходит, он не умеет слать cookie на кросс-доменный
  // handleUploadUrl.
  const [file, setFile] = useState<File | null>(null);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'preparing' | 'uploading' | 'confirming' | 'starting'>('idle');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFileRun() {
    if (!file) return;
    setUploadError(null);
    setRunError(null);
    setConversation(null);
    setRun(null);
    try {
      setUploadPhase('preparing');
      const isVideo = file.type.startsWith('video/');
      const { projectId, conversationId } = await createSandboxUploadConversation(isVideo);

      // Префикс обязан совпадать с AUDIO_PREFIX на бэкенде — токен вне
      // него просто не выдадут.
      const safeName = file.name.replace(/[^\w.\-]+/g, '_') || 'upload';
      const pathname = `conversation-audio/${conversationId}/${safeName}`;
      const { clientToken } = await getSandboxUploadToken(conversationId, pathname);

      setUploadPhase('uploading');
      setUploadPercent(0);
      const { put } = await import('@vercel/blob/client');
      const blob = await put(pathname, file, {
        access: 'private',
        token: clientToken,
        contentType: file.type || 'application/octet-stream',
        multipart: true,
        onUploadProgress: ({ percentage }) => setUploadPercent(percentage),
      });

      setUploadPhase('confirming');
      await confirmSandboxUpload(conversationId, blob.pathname);

      setUploadPhase('starting');
      const started = await sandboxTranscribe(conversationId);

      // Дальше — та же панель статуса и те же кнопки анализа, что у
      // синтетического прогона: run единый для обоих путей.
      setRun({
        projectId,
        conversationId,
        status: started.status,
        externalJobId: started.externalJobId,
        note: 'Реальный файл: после TRANSCRIBED сегментов будет больше нуля — можно запускать анализ ниже.',
      });
    } catch (e) {
      setUploadError(errText(e));
    } finally {
      setUploadPhase('idle');
    }
  }

  // ── Анализ ──
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  async function handleAnalyze(kind: 'manipulation' | 'discrepancy' | 'turning-points') {
    if (!run) return;
    setAnalyzing(kind);
    setAnalysisError(null);
    try {
      const result = await sandboxAnalyze(run.conversationId, kind);
      setAnalysisResult(JSON.stringify(result, null, 2));
      // turning-points ставит ANALYZED — обновляем статус разговора.
      getSandboxConversation(run.conversationId).then(setConversation).catch(() => undefined);
    } catch (e) {
      setAnalysisError(errText(e));
    } finally {
      setAnalyzing(null);
    }
  }

  const consentsItem = status?.items.find((i) => i.key === 'consents');
  const allGreen = status ? status.items.every((i) => i.ok) : false;

  return (
    <div className="page">
      <h1>Sandbox — прогон цепочки YouTube-разбора</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Всё выполняется от имени вашего аккаунта с боевой конфигурацией: реальная квота YouTube
        (лимит 20 поисков/сутки — общий с вашим TMA-аккаунтом), реальные счета AssemblyAI и LLM.
        Ни одна проверка не обходится: отказ здесь означает отказ и у пользователя.
      </p>

      {/* ── 0. Готовность ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Готовность конфигурации</h2>
        {statusError && <p style={{ color: 'var(--signal-critical)' }}>{statusError}</p>}
        {!status && !statusError && <p className="muted">Загрузка…</p>}
        {status && (
          <>
            <table>
              <tbody>
                {status.items.map((item) => (
                  <tr key={item.key}>
                    <td style={{ width: 28 }}>
                      {item.ok ? <span className="badge badge-ok">ок</span> : <span className="badge badge-bad">нет</span>}
                    </td>
                    <td>{item.label}</td>
                    <td className="muted">{item.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button type="button" onClick={loadStatus}>Обновить</button>
              {consentsItem && !consentsItem.ok && !consentsItem.detail?.includes('MAXIMUM_PRIVACY') && (
                <button type="button" onClick={handleGrantConsents} disabled={granting}>
                  {granting ? 'Выдаём…' : 'Выдать согласия своему аккаунту'}
                </button>
              )}
              {!allGreen && (
                <span className="muted" style={{ fontSize: 13 }}>
                  Красные пункты чинятся в переменных окружения проекта API — подробности в VERCEL.md и API-AND-KEYS.md.
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── 1. Поиск ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Шаг 1 — поиск YouTube (метаданные)</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={query}
            placeholder="Запрос, например: дебаты"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={handleSearch} disabled={searching || !query.trim()}>
            {searching ? 'Ищем…' : 'Искать'}
          </button>
        </div>
        {searchError && <p style={{ color: 'var(--signal-critical)', marginTop: 10 }}>{searchError}</p>}
        {search && (
          <>
            <p className="muted" style={{ marginTop: 10 }}>
              {search.results.length} результатов за {search.tookMs} мс. Поиск списал 100 quota-единиц
              из ~10 000/сутки на проект Google Cloud и 1 из 20 ваших суточных поисков.
            </p>
            <table style={{ marginTop: 6 }}>
              <thead>
                <tr><th>Видео</th><th>Канал</th><th>Длительность</th></tr>
              </thead>
              <tbody>
                {search.results.map((r) => (
                  <tr key={r.videoId}>
                    <td>
                      <a href={`https://www.youtube.com/watch?v=${r.videoId}`} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                    </td>
                    <td>{r.channelName}</td>
                    <td>{formatDuration(r.durationSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* ── 2. Транскрибация ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Шаги 4–7 — прогон транскрибации</h2>
        <p className="muted">
          Создаёт песочный проект и разговор на вашем аккаунте, загружает синтетический
          3-секундный WAV в AssemblyAI и ставит задачу. Транскрипт будет пустым — файл без речи;
          проверяется конвейер: ключ, загрузка, адрес вебхука, секрет, запись статусов.
          Терминальный статус TRANSCRIBED = вся цепочка доставки работает.
        </p>
        <button type="button" onClick={handleRun} disabled={running || uploadPhase !== 'idle'}>
          {running ? 'Запускаем…' : 'Прогнать транскрибацию (синтетический WAV)'}
        </button>

        {/* Вторая итерация 2026-08-31 — реальный файл, тот же конвейер.
            После загрузки статус и анализ переиспользуют панель ниже. */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <p className="muted" style={{ marginTop: 0 }}>
            …или загрузите реальное аудио/видео (до 500 МБ): файл уйдёт напрямую в приватное
            хранилище, минуя API, — тем же путём, что у пользователей TMA. После расшифровки
            сегментов будет больше нуля, и анализ ниже станет содержательным. Расшифровка
            AssemblyAI платная — тарификация поминутная.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={uploadPhase !== 'idle'}
            />
            <button type="button" onClick={handleFileRun} disabled={!file || uploadPhase !== 'idle' || running}>
              {uploadPhase === 'idle' && 'Загрузить и расшифровать'}
              {uploadPhase === 'preparing' && 'Готовим разговор…'}
              {uploadPhase === 'uploading' && `Загружаем… ${Math.round(uploadPercent)}%`}
              {uploadPhase === 'confirming' && 'Подтверждаем файл…'}
              {uploadPhase === 'starting' && 'Запускаем расшифровку…'}
            </button>
            {file && uploadPhase === 'idle' && (
              <span className="muted" style={{ fontSize: 13 }}>
                {file.name} · {(file.size / 1024 / 1024).toFixed(1)} МБ
              </span>
            )}
          </div>
          {uploadError && <p style={{ color: 'var(--signal-critical)', marginTop: 10 }}>{uploadError}</p>}
        </div>

        {runError && <p style={{ color: 'var(--signal-critical)', marginTop: 10 }}>{runError}</p>}
        {run && (
          <div style={{ marginTop: 12 }}>
            <div className="muted">Разговор: <code>{run.conversationId}</code> · job: <code>{run.externalJobId ?? '—'}</code></div>
            <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>{run.note}</p>
            <div style={{ marginTop: 8, display: 'flex', gap: 16, alignItems: 'center' }}>
              <span>
                Статус:{' '}
                {!conversation && <span className="badge badge-pending">…</span>}
                {conversation?.status === 'TRANSCRIBING' && <span className="badge badge-pending">TRANSCRIBING — ждём вебхук</span>}
                {conversation?.status === 'TRANSCRIBED' && <span className="badge badge-ok">TRANSCRIBED — конвейер работает</span>}
                {conversation?.status === 'ANALYZED' && <span className="badge badge-ok">ANALYZED</span>}
                {conversation?.status === 'FAILED' && <span className="badge badge-bad">FAILED — см. Runtime Logs</span>}
              </span>
              {conversation && <span className="muted">сегментов: {conversation.segments}</span>}
            </div>
            {conversation?.status === 'TRANSCRIBING' && (
              <p className="muted" style={{ marginTop: 8 }}>
                Обновляется каждые 5 секунд. Если висит дольше пары минут — вебхук не доходит:
                проверьте API_PUBLIC_BASE_URL в чек-листе выше (самая частая причина — домен не того проекта).
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── 3. Анализ ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Шаг 8 — анализ (LLM)</h2>
        <p className="muted">
          Работает по разговору из прогона выше после статуса TRANSCRIBED. На пустом транскрипте
          анализ честно откажет («no transcript segments») — это ожидаемо и подтверждает, что
          проверки работают; для содержательного анализа загрузите реальный разговор через TMA.
          Помните: статус ANALYZED ставит только «Поворотные точки».
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={!run || analyzing !== null} onClick={() => handleAnalyze('manipulation')}>
            {analyzing === 'manipulation' ? 'Анализируем…' : 'Манипуляции'}
          </button>
          <button type="button" disabled={!run || analyzing !== null} onClick={() => handleAnalyze('discrepancy')}>
            {analyzing === 'discrepancy' ? 'Анализируем…' : 'Расхождения'}
          </button>
          <button type="button" disabled={!run || analyzing !== null} onClick={() => handleAnalyze('turning-points')}>
            {analyzing === 'turning-points' ? 'Анализируем…' : 'Поворотные точки'}
          </button>
        </div>
        {analysisError && <p style={{ color: 'var(--signal-critical)', marginTop: 10 }}>{analysisError}</p>}
        {analysisResult && (
          <pre style={{ marginTop: 12, maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{analysisResult}</pre>
        )}
      </div>
    </div>
  );
}
