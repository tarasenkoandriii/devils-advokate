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
  sandboxAddToQueue,
  sandboxLinkQueueItem,
  getSandboxQueue,
  sandboxRetryQueueItem,
  getSandboxAnalysis,
  sandboxFactCheck,
} from '../../lib/endpoints';
import type {
  SandboxStatus,
  SandboxYouTubeSearch,
  SandboxYouTubeResult,
  SandboxTranscriptionRun,
  SandboxConversation,
  SandboxQueue,
  SandboxQueueItem,
  SandboxAnalysis,
  SandboxFactCheck,
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
            // Терминальный статус меняет и элемент очереди
            // (READY→PROCESSING→DONE синхронизируется на её GET).
            loadQueue();
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
  // Третья итерация 2026-08-31 — «Разобрать» у результата поиска:
  // ролик становится элементом песочной очереди, а СЛЕДУЮЩАЯ загрузка
  // файла привязывается к нему (linkConversation → READY→…→DONE).
  // Скачивания ролика с YouTube здесь нет намеренно — граница ТЗ §2.2,
  // песочница подчиняется ей так же, как прод.
  const [queueTarget, setQueueTarget] = useState<{ itemId: string; title: string } | null>(null);
  const [queueTargetError, setQueueTargetError] = useState<string | null>(null);
  const [addingToQueue, setAddingToQueue] = useState<string | null>(null);
  const [queue, setQueue] = useState<SandboxQueue | null>(null);

  const loadQueue = useCallback(() => {
    getSandboxQueue().then((r) => setQueue(r.queue)).catch(() => undefined);
  }, []);
  useEffect(loadQueue, [loadQueue]);

  const [retryingItem, setRetryingItem] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Аккордеон готовности: свёрнут, когда всё зелёное; раскрыт при
  // проблемах (их надо чинить, а не листать мимо).
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => {
    if (status) setStatusOpen(!status.items.every((i) => i.ok));
  }, [status]);

  // Ленивая подгрузка содержимого разбора при раскрытии элемента.
  const [analyses, setAnalyses] = useState<Record<string, SandboxAnalysis | 'loading' | 'error'>>({});

  function loadAnalysis(conversationId: string) {
    if (analyses[conversationId]) return;
    setAnalyses((m) => ({ ...m, [conversationId]: 'loading' }));
    getSandboxAnalysis(conversationId)
      .then((a) => setAnalyses((m) => ({ ...m, [conversationId]: a })))
      .catch(() => setAnalyses((m) => ({ ...m, [conversationId]: 'error' })));
  }

  // Fact Check API — on-demand по кнопке, результаты по conversationId.
  const [factChecks, setFactChecks] = useState<Record<string, SandboxFactCheck | 'loading' | string>>({});

  function runFactCheck(conversationId: string) {
    setFactChecks((m) => ({ ...m, [conversationId]: 'loading' }));
    sandboxFactCheck(conversationId)
      .then((r) => setFactChecks((m) => ({ ...m, [conversationId]: r })))
      .catch((e) => setFactChecks((m) => ({ ...m, [conversationId]: `Ошибка: ${errText(e)}` })));
  }

  function msToTimecode(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  // Пока есть PROCESSING — очередь сама обновляется раз в 15 секунд:
  // прогресс без автообновления был бы мёртвой картинкой.
  useEffect(() => {
    if (!queue?.items.some((i) => i.status === 'PROCESSING')) return;
    const t = setInterval(loadQueue, 15000);
    return () => clearInterval(t);
  }, [queue, loadQueue]);

  /** ПРИБЛИЗИТЕЛЬНЫЙ прогресс разбора — из фактов БД, потому что сами
   * провайдеры прогресса не отдают. Оси две: фаза (статус Conversation
   * и джобы) и время (обработка видео идёт примерно в реальном времени
   * просмотра — замерено на живых прогонах — плюс до двух минут на
   * такты cron). Уже записанный в БД транскрипт двигает оценку выше
   * любых расчётов по времени. Потолок 95% — стопроцентным разбор
   * становится только фактом DONE. */
  function processingProgress(item: SandboxQueueItem): { percent: number; label: string } | null {
    if (item.status !== 'PROCESSING') return null;

    // Транскрипт уже в БД — самая надёжная из оценок: осталась только
    // финализация (для ручного пути — анализ, для авто — смена статуса).
    if (item.segments > 0) {
      return {
        percent: item.conversationStatus === 'TRANSCRIBED' ? 80 : 95,
        label:
          item.conversationStatus === 'TRANSCRIBED'
            ? `транскрипт в БД (${item.segments} сегм.) — ожидает анализа`
            : `транскрипт в БД (${item.segments} сегм.) — финализация`,
      };
    }

    const startedAt = item.job ? new Date(item.job.startedAt).getTime() : null;
    const elapsedSec = startedAt !== null ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;

    // Ручной путь: расшифровка у AssemblyAI (джобы AIRouter нет вовсе).
    if (item.conversationStatus === 'TRANSCRIBING') {
      const expectedSec = 60 + (item.durationSeconds ?? 120) * 0.5; // AssemblyAI быстрее реального времени
      return {
        percent: Math.max(15, Math.min(75, Math.round((elapsedSec / expectedSec) * 60) + 15)),
        label: 'расшифровка у AssemblyAI',
      };
    }

    if (!item.job) {
      return { percent: 5, label: 'подготовка' };
    }

    const expectedSec = 120 + (item.durationSeconds ?? 60) * 1.2;
    let percent = Math.min(95, Math.round((elapsedSec / expectedSec) * 100));
    let label: string;
    if (item.job.status === 'QUEUED' || !item.job.submitted) {
      percent = Math.min(percent, 10);
      label = 'в очереди на постановку (~1 мин)';
    } else if (elapsedSec > expectedSec * 2) {
      // Сильно дольше ожидания — честно говорим, что оценка исчерпана:
      // либо перегруз провайдера (ретраи), либо джобу закроет сторожевая.
      label = 'дольше ожидаемого — идут ретраи либо сработает сторожевая (до 2 ч)';
    } else {
      label = `считается у Gemini, ~${Math.max(1, Math.round((expectedSec - elapsedSec) / 60))} мин осталось`;
    }
    return { percent: Math.max(3, percent), label };
  }

  async function handleRetryItem(itemId: string) {
    setRetryingItem(itemId);
    setRetryError(null);
    try {
      await sandboxRetryQueueItem(itemId);
      loadQueue();
    } catch (e) {
      setRetryError(errText(e));
    } finally {
      setRetryingItem(null);
    }
  }

  async function handleAddToQueue(video: SandboxYouTubeResult) {
    setAddingToQueue(video.videoId);
    setQueueTargetError(null);
    try {
      const { itemId } = await sandboxAddToQueue(video);
      setQueueTarget({ itemId, title: video.title });
      loadQueue();
    } catch (e) {
      setQueueTargetError(errText(e));
    } finally {
      setAddingToQueue(null);
    }
  }

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

      // Если перед загрузкой нажали «Разобрать» у ролика — привязываем
      // разговор к элементу очереди (продовый linkConversation, элемент
      // переходит в READY и дальше живёт синхронизацией статусов).
      if (queueTarget) {
        await sandboxLinkQueueItem(queueTarget.itemId, conversationId);
      }

      setUploadPhase('starting');
      const started = await sandboxTranscribe(conversationId);

      // Дальше — та же панель статуса и те же кнопки анализа, что у
      // синтетического прогона: run единый для обоих путей.
      setRun({
        projectId,
        conversationId,
        status: started.status,
        externalJobId: started.externalJobId,
        note: queueTarget
          ? `Файл привязан к ролику «${queueTarget.title}» — статус элемента очереди внизу страницы.`
          : 'Реальный файл: после TRANSCRIBED сегментов будет больше нуля — можно запускать анализ ниже.',
      });
      setQueueTarget(null);
      loadQueue();
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
      // turning-points ставит ANALYZED — обновляем статус разговора и
      // очередь (элемент перейдёт в DONE именно после этого).
      getSandboxConversation(run.conversationId).then(setConversation).catch(() => undefined);
      loadQueue();
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

      {/* ── 0. Готовность — аккордеон с интегральным статусом ── */}
      <details
        className="card"
        style={{ marginBottom: 20 }}
        open={statusOpen}
        onToggle={(e) => setStatusOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, listStyle: 'none' }}>
          <h2 style={{ margin: 0, display: 'inline' }}>Готовность конфигурации</h2>
          {!status && !statusError && <span className="muted" style={{ fontSize: 13 }}>загрузка…</span>}
          {statusError && <span className="badge badge-bad">недоступно</span>}
          {status && (allGreen ? (
            <span className="badge badge-ok">OK · {status.items.length}/{status.items.length}</span>
          ) : (
            <span className="badge badge-bad">
              проблем: {status.items.filter((i) => !i.ok).length} из {status.items.length}
            </span>
          ))}
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>развернуть ▾</span>
        </summary>
        {statusError && <p style={{ color: 'var(--signal-critical)', marginTop: 12 }}>{statusError}</p>}
        {!status && !statusError && <p className="muted" style={{ marginTop: 12 }}>Загрузка…</p>}
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
      </details>

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
              «Разобрать» кладёт ролик в очередь медиа-разбора и привяжет к нему следующую загрузку
              файла ниже — сам ролик проект с YouTube не скачивает (ТЗ §2.2, легально только метаданные).
            </p>
            {queueTargetError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{queueTargetError}</p>}
            <table style={{ marginTop: 6 }}>
              <thead>
                <tr><th>Видео</th><th>Канал</th><th>Длительность</th><th></th></tr>
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
                    <td>
                      <button
                        type="button"
                        onClick={() => handleAddToQueue(r)}
                        disabled={addingToQueue !== null}
                        title="Добавить в очередь медиа-разбора и привязать к следующей загрузке файла"
                      >
                        {addingToQueue === r.videoId ? 'Добавляем…' : 'Разобрать'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* ── Песочная очередь медиа-разбора — сразу после поиска: сюда
            попадает кнопка «Разобрать», логично видеть результат рядом ── */}
      {queue && queue.items.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>Шаг 2 — очередь медиа-разбора (песочница)</h2>
          <p className="muted">
            Статусы синхронизируются при каждом обновлении. Для роликов из «Разобрать»: PROCESSING —
            задача у Gemini (обычно минуты), DONE — транскрипт и сигналы записаны. Сигналов может быть
            честный ноль: модели запрещено выдумывать их ради количества, короткий развлекательный ролик
            часто чист. Содержимое разбора смотрите в TMA («Разбор публичных видео») или по conversationId.
          </p>
          {retryError && <p style={{ color: 'var(--signal-critical)' }}>{retryError}</p>}
          {queue.items.map((item) => (
            <details
              key={item.id}
              style={{ borderTop: '1px solid var(--border, #2a2f3a)', padding: '10px 0' }}
              onToggle={(e) => {
                // Ленивая подгрузка содержимого разбора при первом раскрытии.
                if ((e.target as HTMLDetailsElement).open && item.conversationId) {
                  loadAnalysis(item.conversationId);
                }
              }}
            >
              <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', listStyle: 'none' }}>
                {item.status === 'DONE' && <span className="badge badge-ok">DONE</span>}
                {item.status === 'PROCESSING' && <span className="badge badge-pending">PROCESSING</span>}
                {item.status === 'READY' && <span className="badge badge-pending">READY</span>}
                {!['DONE', 'PROCESSING', 'READY'].includes(item.status) && (
                  <span className="badge">{item.status}</span>
                )}
                <span style={{ flex: '1 1 260px', minWidth: 200 }}>{item.title || item.youtubeVideoId}</span>
                {(() => {
                  const progress = processingProgress(item);
                  if (progress) {
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} title={progress.label}>
                        <span style={{ width: 110, height: 6, borderRadius: 3, background: 'var(--border, #2a2f3a)', overflow: 'hidden', display: 'inline-block' }}>
                          <span style={{ display: 'block', height: '100%', width: `${progress.percent}%`, background: 'var(--signal-ok, #3fb27f)', transition: 'width 1s linear' }} />
                        </span>
                        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>≈{progress.percent}% · {progress.label}</span>
                      </span>
                    );
                  }
                  return (
                    <span className="muted" style={{ fontSize: 13 }}>
                      {item.segments > 0 ? `${item.segments} сегм. / ${item.signals} сигн.` : item.autoAnalysisError ? 'ошибка' : '—'}
                    </span>
                  );
                })()}
                {item.status !== 'DONE' && item.status !== 'PROCESSING' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      // Кнопка в summary: не даём клику схлопнуть аккордеон.
                      e.preventDefault();
                      e.stopPropagation();
                      handleRetryItem(item.id);
                    }}
                    disabled={retryingItem !== null}
                    title="Поставить автоматический разбор заново (после квоты/сбоя)"
                  >
                    {retryingItem === item.id ? 'Ставим…' : 'Повторить'}
                  </button>
                )}
                <span className="muted" style={{ fontSize: 12 }}>▾</span>
              </summary>

              <div style={{ padding: '10px 0 4px 4px', fontSize: 13 }}>
                <div className="muted" style={{ marginBottom: 6 }}>
                  <a href={`https://www.youtube.com/watch?v=${item.youtubeVideoId}`} target="_blank" rel="noreferrer">
                    открыть на YouTube
                  </a>
                  {' · '}разговор: {item.conversationId ? <code>{item.conversationId}</code> : 'файл не привязан'}
                </div>
                {item.autoAnalysisError && (
                  <div style={{ color: 'var(--signal-critical)', marginBottom: 8, maxWidth: 720 }}>
                    {item.autoAnalysisError}
                  </div>
                )}
                {item.conversationId && (() => {
                  const a = analyses[item.conversationId];
                  if (!a) return null;
                  if (a === 'loading') return <p className="muted">Загружаем разбор…</p>;
                  if (a === 'error') return <p style={{ color: 'var(--signal-critical)' }}>Не удалось загрузить разбор</p>;
                  if (a.segments.length === 0) {
                    return <p className="muted">Транскрипт пуст — разбор ещё не записан либо завершился отказом.</p>;
                  }
                  return (
                    <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--border, #2a2f3a)', borderRadius: 6, padding: '8px 10px' }}>
                      {a.language && <div className="muted" style={{ marginBottom: 6 }}>язык: {a.language}</div>}
                      {a.segments.map((seg, i) => (
                        <div key={i} style={{ marginBottom: 8 }}>
                          <span className="muted" style={{ fontSize: 12 }}>
                            [{msToTimecode(seg.startMs)}–{msToTimecode(seg.endMs)}] {seg.speaker ?? '—'}:
                          </span>{' '}
                          {seg.text}
                          {seg.signals.length > 0 && (
                            <div style={{ marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {seg.signals.map((sig, j) => (
                                <span key={j} className="badge badge-pending" title={sig.channel ?? undefined}>
                                  {sig.type}
                                  {sig.confidence !== null ? ` · ${Math.round(sig.confidence * 100)}%` : ''}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Fact Check API — только по готовому разбору. Поиск по
                    базе опубликованных фактчеков, НЕ вердикт о
                    правдивости: отсутствие совпадений ничего не
                    доказывает. */}
                {item.conversationId && item.status === 'DONE' && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      onClick={() => runFactCheck(item.conversationId as string)}
                      disabled={factChecks[item.conversationId] === 'loading'}
                      title="Поиск по базе опубликованных фактчеков (Google Fact Check Tools API), до 8 сегментов за нажатие"
                    >
                      {factChecks[item.conversationId] === 'loading' ? 'Проверяем…' : 'Проверить факты (Fact Check API)'}
                    </button>
                    {(() => {
                      const fc = factChecks[item.conversationId as string];
                      if (!fc || fc === 'loading') return null;
                      if (typeof fc === 'string') return <p style={{ color: 'var(--signal-critical)', marginTop: 8 }}>{fc}</p>;
                      const withMatches = fc.results.filter((r) => r.matches.length > 0);
                      return (
                        <div style={{ marginTop: 8, fontSize: 13 }}>
                          <p className="muted" style={{ margin: '0 0 6px' }}>
                            Проверено сегментов: {fc.checkedSegments} из {fc.totalSegments}. Совпадения найдены
                            в {withMatches.length}. Это поиск по базе опубликованных фактчеков — отсутствие
                            совпадений НЕ подтверждает утверждение.
                          </p>
                          {withMatches.map((r) => (
                            <div key={r.segmentId} style={{ marginBottom: 10, border: '1px solid var(--border, #2a2f3a)', borderRadius: 6, padding: '6px 10px' }}>
                              <div className="muted" style={{ fontSize: 12 }}>[{msToTimecode(r.startMs)}] {r.text.slice(0, 160)}</div>
                              {r.matches.map((m, i) => (
                                <div key={i} style={{ marginTop: 4 }}>
                                  <span className="badge badge-pending">{m.rating ?? 'без оценки'}</span>{' '}
                                  {m.claim}
                                  {m.claimant && <span className="muted"> — {m.claimant}</span>}
                                  {m.url && (
                                    <>
                                      {' '}
                                      <a href={m.url} target="_blank" rel="noreferrer">
                                        {m.publisher ?? 'источник'}
                                      </a>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </details>
          ))}
          <button type="button" onClick={loadQueue} style={{ marginTop: 10 }}>Обновить</button>
        </div>
      )}

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
          {queueTarget && (
            <p style={{ marginTop: 0 }}>
              Файл будет привязан к ролику: <strong>{queueTarget.title}</strong>{' '}
              <button type="button" onClick={() => setQueueTarget(null)} style={{ marginLeft: 8 }}>
                Отвязать
              </button>
            </p>
          )}
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
