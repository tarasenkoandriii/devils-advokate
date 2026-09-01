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
  sandboxDiagnoseQueueItem,
  sandboxIntakeStart,
  sandboxIntakeAnswer,
  sandboxIntakeDispatch,
  sandboxHealthAnswer,
  sandboxHealthExtract,
  sandboxHealthConfig,
  sandboxHealthLabDocument,
  sandboxHealthLabVerify,
  sandboxMpAnswer,
  sandboxMpChecklist,
  sandboxMpExtract,
  sandboxMpConfig,
  sandboxMpVariant,
  sandboxMpComparison,
  sandboxInvAnswer,
  sandboxInvExtract,
  sandboxInvConfig,
  sandboxInvOpportunity,
  sandboxInvSourceComparison,
  sandboxInvComparison,
  sandboxInvGroupSmoke,
  sandboxIpAnswer,
  sandboxIpExtract,
  sandboxIpConfig,
  sandboxIpQuestionnaireDraft,
  sandboxIpQuestionnaireFix,
  sandboxIpCandidate,
  sandboxIpRelevance,
  sandboxIpSummaryReport,
  sandboxIpTeamSmoke,
  sandboxFlAnswer,
  sandboxFlExtract,
  sandboxFlConfig,
  sandboxFlParty,
  sandboxFlAsset,
  sandboxFlBudgetItem,
  sandboxFlSettlementDraft,
  sandboxDtpAnswer,
  sandboxDtpExtract,
  sandboxDtpConfig,
  sandboxDtpParticipant,
  sandboxDtpFault,
  sandboxDtpEvidence,
  sandboxDtpSettlementDraft,
  sandboxMpMeetingConclusion,
  sandboxInvMeetingBreakdown,
  sandboxIpAttachInterview,
  sandboxFlConsultationBreakdown,
  sandboxDtpConsultationBreakdown,
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
  SandboxDiagnosis,
  SandboxIntakeState,
  SandboxHealthDraft,
  SandboxMpDraft,
  SandboxMpComparison,
  SandboxInvDraft,
  SandboxInvComparison,
  SandboxInvGroupSmoke,
  SandboxIpDraft,
  SandboxIpQuestionnaireItem,
  SandboxIpRelevance,
  SandboxIpSummaryReport,
  SandboxIpTeamSmoke,
  SandboxFlDraft,
  SandboxFlBudget,
  SandboxFlSettlementDraft,
  SandboxDtpDraft,
  SandboxDtpEvidence,
} from '../../lib/types';
import { VoiceTextInput } from '../../components/VoiceTextInput';

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

  // ── Intake-квиз (Шаг 3): живой классификатор + dispatch в домен ──
  const [intakeText, setIntakeText] = useState('');
  const [intakeState, setIntakeState] = useState<SandboxIntakeState | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [dispatchScenario, setDispatchScenario] = useState<string>('');
  const [contractType, setContractType] = useState<'PRENUP' | 'DIVORCE_SETTLEMENT'>('PRENUP');

  const INTAKE_PRESETS: Array<{ label: string; text: string }> = [
    { label: 'Пример: ДТП', text: 'Вчера на перекрёстке в меня въехала машина. Виновник вину признал, но страховая занижает сумму ремонта почти вдвое. Хочу понять, как добиться полной выплаты.' },
    { label: 'Пример: инвестиции', text: 'Знакомый советник предлагает вложить 500 тысяч в фонд с гарантированной доходностью 30% годовых и комиссией 2% за вход. Звучит слишком хорошо, хочу проверить его аргументы.' },
    { label: 'Пример: здоровье', text: 'Врач настаивает на операции на колене, но я сомневаюсь — хочу подготовиться ко второму мнению: какие вопросы задать по анализам и снимку МРТ.' },
  ];

  async function handleIntake(action: () => Promise<SandboxIntakeState>) {
    setIntakeBusy(true);
    setIntakeError(null);
    try {
      const state = await action();
      setIntakeState(state);
      if (state.decision) setDispatchScenario(state.decision.scenario);
      setIntakeText('');
    } catch (e) {
      setIntakeError(errText(e));
    } finally {
      setIntakeBusy(false);
    }
  }

  // ── Продолжение онбординга здоровья после dispatch (Шаг 3) ──
  const [healthAnswerText, setHealthAnswerText] = useState('');
  const [healthDraft, setHealthDraft] = useState<SandboxHealthDraft | null>(null);
  const [healthConfigId, setHealthConfigId] = useState<string | null>(null);
  const [healthBusy, setHealthBusy] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [labDraft, setLabDraft] = useState<{ id: string; ocrText: string; verified: boolean } | null>(null);

  async function withHealth(action: string, fn: () => Promise<void>) {
    setHealthBusy(action);
    setHealthError(null);
    try {
      await fn();
    } catch (e) {
      setHealthError(errText(e));
    } finally {
      setHealthBusy(null);
    }
  }

  // ── Пункт [sandbox-major-purchase] 2026-09-01 — этап 1 доменного
  // покрытия: крупная покупка после dispatch. Ответы → чек-лист (AI)
  // → extract (AI) → конфиг → варианты → сравнительная таблица.
  const [mpCategory, setMpCategory] = useState<'REAL_ESTATE' | 'VEHICLE'>('VEHICLE');
  const [mpAnswerText, setMpAnswerText] = useState('');
  const [mpChecklistItems, setMpChecklistItems] = useState<string[] | null>(null);
  const [mpDraft, setMpDraft] = useState<SandboxMpDraft | null>(null);
  const [mpConfigId, setMpConfigId] = useState<string | null>(null);
  const [mpVariantLabel, setMpVariantLabel] = useState('');
  const [mpVariantPrice, setMpVariantPrice] = useState('');
  const [mpComparison, setMpComparison] = useState<SandboxMpComparison | null>(null);
  const [mpBusy, setMpBusy] = useState<string | null>(null);
  const [mpError, setMpError] = useState<string | null>(null);

  async function withMp(action: string, fn: () => Promise<void>) {
    setMpBusy(action);
    setMpError(null);
    try {
      await fn();
    } catch (e) {
      setMpError(errText(e));
    } finally {
      setMpBusy(null);
    }
  }

  // ── Пункт [sandbox-investment] 2026-09-01 — этап 2 доменного
  // покрытия: инвестиции после dispatch + смоук групп.
  const [invAnswerText, setInvAnswerText] = useState('');
  const [invDraft, setInvDraft] = useState<SandboxInvDraft | null>(null);
  const [invConfigId, setInvConfigId] = useState<string | null>(null);
  const [invOppLabel, setInvOppLabel] = useState('');
  const [invOppAdvisor, setInvOppAdvisor] = useState('');
  const [invOppId, setInvOppId] = useState<string | null>(null);
  const [invSourceUrl, setInvSourceUrl] = useState('');
  const [invSourceResult, setInvSourceResult] = useState<{ sourceUrl: string; sourceTextLength: number; sourceTextPreview: string } | null>(null);
  const [invComparison, setInvComparison] = useState<SandboxInvComparison | null>(null);
  const [invGroupResult, setInvGroupResult] = useState<SandboxInvGroupSmoke | null>(null);
  const [invBusy, setInvBusy] = useState<string | null>(null);
  const [invError, setInvError] = useState<string | null>(null);

  async function withInv(action: string, fn: () => Promise<void>) {
    setInvBusy(action);
    setInvError(null);
    try {
      await fn();
    } catch (e) {
      setInvError(errText(e));
    } finally {
      setInvBusy(null);
    }
  }

  // ── Пункт [sandbox-interview-pool] 2026-09-01 — этап 3 доменного
  // покрытия: подбор персонала после dispatch.
  const [ipAnswerText, setIpAnswerText] = useState('');
  const [ipDraft, setIpDraft] = useState<SandboxIpDraft | null>(null);
  const [ipConfigDone, setIpConfigDone] = useState(false);
  const [ipQuestionnaire, setIpQuestionnaire] = useState<SandboxIpQuestionnaireItem[] | null>(null);
  const [ipQuestionnaireFixed, setIpQuestionnaireFixed] = useState(false);
  const [ipCandidateName, setIpCandidateName] = useState('');
  const [ipCandidateResume, setIpCandidateResume] = useState('');
  const [ipCandidates, setIpCandidates] = useState<string[]>([]);
  const [ipRelevanceRes, setIpRelevanceRes] = useState<SandboxIpRelevance | null>(null);
  const [ipReport, setIpReport] = useState<SandboxIpSummaryReport | null>(null);
  const [ipTeamRes, setIpTeamRes] = useState<SandboxIpTeamSmoke | null>(null);
  const [ipBusy, setIpBusy] = useState<string | null>(null);
  const [ipError, setIpError] = useState<string | null>(null);

  async function withIp(action: string, fn: () => Promise<void>) {
    setIpBusy(action);
    setIpError(null);
    try {
      await fn();
    } catch (e) {
      setIpError(errText(e));
    } finally {
      setIpBusy(null);
    }
  }

  // ── Пункт [sandbox-family-law] 2026-09-01 — этап 4 доменного
  // покрытия: семейное право после dispatch.
  const [flAnswerText, setFlAnswerText] = useState('');
  const [flDraft, setFlDraft] = useState<SandboxFlDraft | null>(null);
  const [flConfigId, setFlConfigId] = useState<string | null>(null);
  const [flParties, setFlParties] = useState<string[]>([]);
  const [flPartyRole, setFlPartyRole] = useState<'SELF' | 'SPOUSE'>('SELF');
  const [flPartyName, setFlPartyName] = useState('');
  const [flAssetType, setFlAssetType] = useState('');
  const [flAssetValue, setFlAssetValue] = useState('');
  const [flAssets, setFlAssets] = useState<string[]>([]);
  const [flBudgetAmount, setFlBudgetAmount] = useState('');
  const [flBudgetCategory, setFlBudgetCategory] = useState('LEGAL_FEES');
  const [flBudgetDirection, setFlBudgetDirection] = useState('EXPENSE');
  const [flBudget, setFlBudget] = useState<SandboxFlBudget | null>(null);
  const [flSettlement, setFlSettlement] = useState<SandboxFlSettlementDraft | null>(null);
  const [flBusy, setFlBusy] = useState<string | null>(null);
  const [flError, setFlError] = useState<string | null>(null);

  async function withFl(action: string, fn: () => Promise<void>) {
    setFlBusy(action);
    setFlError(null);
    try {
      await fn();
    } catch (e) {
      setFlError(errText(e));
    } finally {
      setFlBusy(null);
    }
  }

  // ── Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного покрытия:
  // ДТП после dispatch (последним — данные собирать труднее).
  const [dtpAnswerText, setDtpAnswerText] = useState('');
  const [dtpDraft, setDtpDraft] = useState<SandboxDtpDraft | null>(null);
  const [dtpConfigId, setDtpConfigId] = useState<string | null>(null);
  const [dtpRole, setDtpRole] = useState<'SELF' | 'OTHER_PARTY' | 'THIRD_PARTY'>('SELF');
  const [dtpParticipants, setDtpParticipants] = useState<string[]>([]);
  const [dtpFaultSource, setDtpFaultSource] = useState('POLICE');
  const [dtpFaultText, setDtpFaultText] = useState('');
  const [dtpFaultDone, setDtpFaultDone] = useState(false);
  const [dtpEvidence, setDtpEvidence] = useState<SandboxDtpEvidence | null>(null);
  const [dtpSettlement, setDtpSettlement] = useState<SandboxFlSettlementDraft | null>(null);
  const [dtpBusy, setDtpBusy] = useState<string | null>(null);
  const [dtpError, setDtpError] = useState<string | null>(null);

  async function withDtp(action: string, fn: () => Promise<void>) {
    setDtpBusy(action);
    setDtpError(null);
    try {
      await fn();
    } catch (e) {
      setDtpError(errText(e));
    } finally {
      setDtpBusy(null);
    }
  }

  // Диагностика зависшего PROCESSING: живой статус у провайдера +
  // внеочередной опрос + вердикт словами. По itemId.
  const [diagnoses, setDiagnoses] = useState<Record<string, SandboxDiagnosis | 'loading' | string>>({});

  function runDiagnose(itemId: string) {
    setDiagnoses((m) => ({ ...m, [itemId]: 'loading' }));
    sandboxDiagnoseQueueItem(itemId)
      .then((d) => {
        setDiagnoses((m) => ({ ...m, [itemId]: d }));
        loadQueue(); // диагностика могла продвинуть джобу (внеочередной опрос)
      })
      .catch((e) => setDiagnoses((m) => ({ ...m, [itemId]: `Ошибка: ${errText(e)}` })));
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

    // Короткие ролики Gemini считает ≈ в реальном времени, но длинные
    // фоновая очередь держит непропорционально дольше (замечено на
    // 10-минутных дебатах) — коэффициент 2 и базовые 3 минуты на такты
    // крона и очередь.
    const expectedSec = 180 + (item.durationSeconds ?? 60) * 2;
    let percent = Math.min(95, Math.round((elapsedSec / expectedSec) * 100));
    let label: string;
    if (item.job.status === 'QUEUED' || !item.job.submitted) {
      percent = Math.min(percent, 10);
      label =
        item.job.retryCount > 0
          ? `повторная постановка (попытка ${item.job.retryCount + 1})`
          : 'в очереди на постановку (~1 мин)';
    } else if (elapsedSec > expectedSec) {
      // Оценка по времени исчерпана — дальше говорим ФАКТАМИ из БД,
      // а не гаданием: заметка воркера различает «ретраи на
      // перегрузе» и «просто долго считает», сторожевая — с точным
      // временем вместо «до 2 ч».
      const watchdog =
        item.job.leaseExpiresAt
          ? `сторожевая через ~${Math.max(1, Math.round((new Date(item.job.leaseExpiresAt).getTime() - Date.now()) / 60000))} мин`
          : 'сторожевая до 2 ч';
      if (item.job.note && item.job.note.includes('ожидание')) {
        label = `провайдер отвечает ошибками, идут ретраи опроса · ${watchdog}`;
      } else if (item.job.retryCount > 0) {
        label = `повторная постановка (попытка ${item.job.retryCount + 1}) · ${watchdog}`;
      } else {
        label = `фоновая очередь Google держит дольше обычного · ${watchdog}`;
      }
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

  // ── Пункт [sandbox-domain-conversations] 2026-09-01 — b-подэтапы:
  // Шаг 2 умеет грузить запись в ДОМЕННЫЙ проект (кнопка в панели
  // домена ставит цель), расшифрованный conversationId подставляется
  // в поле b-шага автоматически.
  const [uploadTargetProject, setUploadTargetProject] = useState<{ projectId: string; label: string } | null>(null);
  const [bConversationId, setBConversationId] = useState('');
  const [bBusy, setBBusy] = useState(false);
  const [bError, setBError] = useState<string | null>(null);
  const [bResult, setBResult] = useState<{ summary: string; breakdown: unknown } | null>(null);

  async function runBStep(fn: () => Promise<{ summary: string; breakdown: unknown }>) {
    setBBusy(true);
    setBError(null);
    try {
      setBResult(await fn());
    } catch (e) {
      setBError(errText(e));
    } finally {
      setBBusy(false);
    }
  }

  // Общий блок b-шага для панелей доменов: цель загрузки → id
  // расшифрованного разговора → продовый AI-разбор.
  function renderBStep(opts: { projectId: string; label: string; runLabel: string; disabledReason?: string | null; onRun: (conversationId: string) => Promise<{ summary: string; breakdown: unknown }> }) {
    const targeted = uploadTargetProject?.projectId === opts.projectId;
    return (
      <div style={{ marginTop: 10, borderTop: '1px dashed var(--border, #2a2f3a)', paddingTop: 8 }}>
        <b>Подэтап b — запись разговора + AI-разбор</b>
        <p className="muted" style={{ margin: '4px 0 6px', fontSize: 12 }}>
          1) нажмите «Грузить сюда», 2) загрузите файл в Шаге 2 (расшифровка платная), 3) после
          расшифровки id подставится сам — запустите разбор.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setUploadTargetProject(targeted ? null : { projectId: opts.projectId, label: opts.label })}
          >
            {targeted ? '✓ Шаг 2 грузит сюда — сбросить' : 'Грузить сюда (Шаг 2)'}
          </button>
          <input
            type="text"
            value={bConversationId}
            onChange={(e) => setBConversationId(e.target.value)}
            placeholder="conversationId расшифрованного разговора…"
            style={{ flex: '1 1 260px' }}
          />
          <button
            type="button"
            disabled={bBusy || !bConversationId.trim() || Boolean(opts.disabledReason)}
            title={opts.disabledReason ?? undefined}
            onClick={() => runBStep(() => opts.onRun(bConversationId.trim()))}
          >
            {bBusy ? 'Разбираем…' : opts.runLabel}
          </button>
        </div>
        {opts.disabledReason && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>{opts.disabledReason}</p>}
        {bError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{bError}</p>}
        {bResult && (
          <div style={{ marginTop: 6, fontSize: 13 }}>
            <span className="badge badge-ok">РАЗБОР ГОТОВ</span> {bResult.summary}
            {bResult.breakdown != null && (
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, marginTop: 4 }}>{JSON.stringify(bResult.breakdown, null, 2)}</pre>
            )}
          </div>
        )}
      </div>
    );
  }

  async function handleFileRun() {
    if (!file) return;
    setUploadError(null);
    setRunError(null);
    setConversation(null);
    setRun(null);
    try {
      setUploadPhase('preparing');
      const isVideo = file.type.startsWith('video/');
      const { projectId, conversationId } = await createSandboxUploadConversation(isVideo, undefined, uploadTargetProject?.projectId);

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

      // b-подэтап: id разговора в доменном проекте подставляется в поле
      // разбора сам — оператору не нужно копировать его руками.
      if (uploadTargetProject) setBConversationId(conversationId);

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
                {item.status === 'PROCESSING' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      runDiagnose(item.id);
                    }}
                    disabled={diagnoses[item.id] === 'loading'}
                    title="Спросить у провайдера живой статус, прогнать внеочередной опрос и получить вердикт: сбой это или честное ожидание"
                  >
                    {diagnoses[item.id] === 'loading' ? 'Диагностируем…' : 'Диагностика'}
                  </button>
                )}
                <span className="muted" style={{ fontSize: 12 }}>▾</span>
              </summary>

              <div style={{ padding: '10px 0 4px 4px', fontSize: 13 }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  {/* Метаданные ролика — из YouTube (получены при поиске,
                      само видео проект не скачивал). */}
                  {item.durationSeconds !== null && <>длительность {formatDuration(item.durationSeconds)}{' · '}</>}
                  {item.channelName && <>канал {item.channelName}{' · '}</>}
                  {item.publishedAt && <>опубликован {new Date(item.publishedAt).toLocaleDateString('ru-RU')}{' · '}</>}
                  {item.addedAt && <>добавлен в очередь {new Date(item.addedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</>}
                </div>
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
                {(() => {
                  const d = diagnoses[item.id];
                  if (!d || d === 'loading') return null;
                  if (typeof d === 'string') return <p style={{ color: 'var(--signal-critical)' }}>{d}</p>;
                  return (
                    <div style={{ marginBottom: 10, border: '1px solid var(--border, #2a2f3a)', borderRadius: 6, padding: '8px 10px', fontSize: 13 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.verdict}</div>
                      {d.steps.map((s, i) => (
                        <div key={i} className="muted" style={{ fontSize: 12 }}>· {s}</div>
                      ))}
                    </div>
                  );
                })()}
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
                      // Пункт [fact-check-unmask] 2026-09-01 — частичные
                      // сбои поиска показываются явно (полный отказ по
                      // всем сегментам backend теперь отдаёт ошибкой
                      // запроса — ветка typeof fc === 'string' выше).
                      const withErrors = fc.results.filter((r) => r.error);
                      // Пункт [fact-check-ai-fallback] 2026-09-01 —
                      // показываются и сегменты с AI-гипотезой: та же
                      // кнопка, два слоя результата, ясно размеченных.
                      const shown = fc.results.filter((r) => r.matches.length > 0 || r.ai);
                      const AI_VERDICT_LABELS: Record<string, string> = {
                        SUPPORTED: 'согласуется с фактами',
                        CONTRADICTED: 'противоречит фактам',
                        DISPUTED: 'источники расходятся',
                        UNVERIFIABLE: 'непроверяемо',
                      };
                      return (
                        <div style={{ marginTop: 8, fontSize: 13 }}>
                          <p className="muted" style={{ margin: '0 0 6px' }}>
                            Проверено сегментов: {fc.checkedSegments} из {fc.totalSegments}. Совпадения в базе
                            фактчеков: {withMatches.length}
                            {fc.aiFallbackUsed && <> · AI-гипотезы: {fc.aiCheckedSegments} (модель с веб-поиском — это ГИПОТЕЗА, не подтверждённый фактчек)</>}.
                            Отсутствие совпадений НЕ подтверждает утверждение.
                          </p>
                          {!fc.apiKeyPresent && (
                            <p style={{ color: 'var(--signal-critical)', margin: '0 0 6px' }}>
                              FACT_CHECK_TOOLS_API_KEY не задан — база фактчеков пропущена, ниже только AI-гипотезы.
                            </p>
                          )}
                          {fc.apiKeyPresent && withErrors.length > 0 && (
                            <p style={{ color: 'var(--signal-critical)', margin: '0 0 6px' }}>
                              Сбой поиска по {withErrors.length} сегм.: {withErrors[0].error}
                            </p>
                          )}
                          {fc.aiError && (
                            <p style={{ color: 'var(--signal-critical)', margin: '0 0 6px' }}>
                              AI-фоллбек не удался: {fc.aiError}
                            </p>
                          )}
                          {shown.map((r) => (
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
                              {r.ai && (
                                <div style={{ marginTop: 4 }}>
                                  <span
                                    className={`badge ${r.ai.verdict === 'CONTRADICTED' ? 'badge-bad' : r.ai.verdict === 'SUPPORTED' ? 'badge-ok' : 'badge-pending'}`}
                                    title="Гипотеза модели с веб-поиском — не рейтинг аккредитованного фактчекера"
                                  >
                                    AI: {AI_VERDICT_LABELS[r.ai.verdict] ?? r.ai.verdict} · {Math.round(r.ai.confidence * 100)}%
                                  </span>{' '}
                                  <span>{r.ai.rationale}</span>
                                  {r.ai.sources.length > 0 && (
                                    <span className="muted"> — источники (не проверены): {r.ai.sources.join('; ')}</span>
                                  )}
                                </div>
                              )}
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

      {/* ── 3. Intake-квиз — маршрутизация во все домены ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Шаг 3 — intake-квиз (маршрутизация доменов)</h2>
        <p className="muted">
          Продовый вход в доменные сценарии: описание ситуации → живая классификация LLM (реальные
          токены) → до 3 уточняющих вопросов → передача в выбранный домен. Dispatch создаёт
          настоящий проект на вашем аккаунте — воронка на странице «Сценарии» оживёт этим прогоном.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {INTAKE_PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => setIntakeText(p.text)} disabled={intakeBusy}>
              {p.label}
            </button>
          ))}
        </div>
        {/* Голос и текст равноправны — тот же VoiceTextInput-путь, что в
            TMA: токен → браузер → AssemblyAI напрямую. */}
        <VoiceTextInput
          value={intakeText}
          onChange={setIntakeText}
          disabled={intakeBusy}
          placeholder={intakeState?.nextQuestion ? 'Ваш ответ на уточняющий вопрос…' : 'Опишите ситуацию своими словами — можно голосом…'}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          {(!intakeState || intakeState.status !== 'IN_PROGRESS' || !intakeState.nextQuestion) && (
            <button
              type="button"
              disabled={intakeBusy || !intakeText.trim()}
              onClick={() => handleIntake(() => sandboxIntakeStart(intakeText))}
            >
              {intakeBusy ? 'Классифицируем…' : 'Начать квиз'}
            </button>
          )}
          {intakeState?.nextQuestion && intakeState.status === 'IN_PROGRESS' && (
            <button
              type="button"
              disabled={intakeBusy || !intakeText.trim()}
              onClick={() => handleIntake(() => sandboxIntakeAnswer(intakeState.id, intakeText))}
            >
              {intakeBusy ? 'Классифицируем…' : 'Ответить'}
            </button>
          )}
          {intakeState && <span className="muted" style={{ fontSize: 12 }}>сессия <code>{intakeState.id}</code> · уточнений осталось: {intakeState.followUpsLeft}</span>}
        </div>
        {intakeError && <p style={{ color: 'var(--signal-critical)', marginTop: 8 }}>{intakeError}</p>}

        {intakeState && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {intakeState.answers.map((a, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                {a.question && <div className="muted">квиз: {a.question}</div>}
                <div>— {a.text}</div>
              </div>
            ))}
            {intakeState.nextQuestion && intakeState.status === 'IN_PROGRESS' && (
              <p style={{ marginTop: 8 }}><b>Уточняющий вопрос:</b> {intakeState.nextQuestion}</p>
            )}
            {intakeState.decision && (
              <div style={{ marginTop: 8, border: '1px solid var(--border, #2a2f3a)', borderRadius: 6, padding: '8px 10px' }}>
                <div>
                  <b>Решение:</b> {intakeState.decision.scenario}{' '}
                  <span className="muted">
                    (предложено {intakeState.decision.suggestedScenario}, уверенность {Math.round(intakeState.decision.confidence * 100)}%
                    {intakeState.decision.belowThreshold ? ' — ниже порога, сведено к UNIVERSAL' : ''})
                  </span>
                </div>
                {intakeState.extracted && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    вопрос: {intakeState.extracted.question}
                    {intakeState.extracted.goal && <> · цель: {intakeState.extracted.goal}</>}
                    {intakeState.extracted.facts.length > 0 && <> · факты: {intakeState.extracted.facts.join('; ')}</>}
                  </div>
                )}
                {intakeState.status !== 'DISPATCHED' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={dispatchScenario} onChange={(e) => setDispatchScenario(e.target.value)}>
                      {['UNIVERSAL', 'dtp', 'family-law', 'health', 'interview-pool', 'investment', 'major-purchase'].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    {dispatchScenario === 'family-law' && (
                      <select value={contractType} onChange={(e) => setContractType(e.target.value as 'PRENUP' | 'DIVORCE_SETTLEMENT')}>
                        <option value="PRENUP">PRENUP</option>
                        <option value="DIVORCE_SETTLEMENT">DIVORCE_SETTLEMENT</option>
                      </select>
                    )}
                    <button
                      type="button"
                      disabled={intakeBusy}
                      onClick={() =>
                        handleIntake(() =>
                          sandboxIntakeDispatch(
                            intakeState.id,
                            dispatchScenario,
                            dispatchScenario === 'family-law' ? contractType : undefined,
                          ),
                        )
                      }
                    >
                      {intakeBusy ? 'Передаём…' : 'Передать в сценарий'}
                    </button>
                  </div>
                )}
                {intakeState.status === 'DISPATCHED' && (
                  <div style={{ marginTop: 8 }}>
                    <span className="badge badge-ok">DISPATCHED</span>{' '}
                    в {intakeState.chosenScenario} · проект <code>{intakeState.projectId ?? intakeState.dispatchedProjectId}</code>
                    {intakeState.conversationId && <> · онбординг-разговор <code>{intakeState.conversationId}</code></>}
                    <div className="muted" style={{ marginTop: 4 }}>
                      Воронка обновилась — смотрите страницу «Сценарии» (колонки «Всего»/«С конфигом»).
                    </div>

                    {/* Продолжение онбординга здоровья: ответы → extract →
                        config. Именно config двигает колонку «С конфигом». */}
                    {intakeState.chosenScenario === 'health' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг здоровья</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Ответы квиза уже перенесены в разговор. Добавьте недостающее (бюджет, что
                          беспокоит в рисках) и нажмите «Извлечь конфиг» — реальный LLM-вызов.
                        </p>
                        {!healthDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={healthAnswerText}
                              onChange={(e) => setHealthAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={healthBusy !== null || !healthAnswerText.trim()}
                              onClick={() =>
                                withHealth('answer', async () => {
                                  await sandboxHealthAnswer(intakeState.conversationId as string, healthAnswerText);
                                  setHealthAnswerText('');
                                })
                              }
                            >
                              {healthBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={healthBusy !== null}
                              onClick={() =>
                                withHealth('extract', async () => {
                                  setHealthDraft(await sandboxHealthExtract(intakeState.conversationId as string));
                                })
                              }
                            >
                              {healthBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {healthDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>Черновик конфига:</b> {healthDraft.goalDescription}</div>
                            {healthDraft.targetBudget !== null && (
                              <div className="muted">бюджет: {healthDraft.targetBudget} {healthDraft.currency ?? ''}</div>
                            )}
                            <ul style={{ margin: '6px 0' }}>
                              {healthDraft.criteria.map((c, i) => (
                                <li key={i}>
                                  <span className="badge badge-pending">{c.category}</span> {c.text}
                                  {c.isRequired && <span className="muted"> · обязательный</span>}
                                </li>
                              ))}
                            </ul>
                            {!healthConfigId ? (
                              <button
                                type="button"
                                disabled={healthBusy !== null}
                                onClick={() =>
                                  withHealth('config', async () => {
                                    const res = await sandboxHealthConfig(
                                      (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                      healthDraft,
                                    );
                                    setHealthConfigId(res.id);
                                  })
                                }
                              >
                                {healthBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span> <code>{healthConfigId}</code>
                                <span className="muted"> — воронка health дошла до «С конфигом»</span>

                                {/* OCR лабдокумента: реальный Cloud Vision,
                                    дневной лимит 10, изображение не
                                    персистуется — только извлечённый текст
                                    черновиком (verified: false). */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Лабдокумент (Vision OCR)</b>
                                  <p className="muted" style={{ margin: '4px 0 6px', fontSize: 12 }}>
                                    Изображение с текстом (фото анализа, до ~3 МБ — лимит тела запроса).
                                    Нужен GOOGLE_VISION_API_KEY — см. чеклист готовности.
                                  </p>
                                  {!labDraft && (
                                    <input
                                      type="file"
                                      accept="image/*"
                                      disabled={healthBusy !== null}
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (!f) return;
                                        const reader = new FileReader();
                                        reader.onload = () =>
                                          withHealth('ocr', async () => {
                                            const dataUrl = String(reader.result ?? '');
                                            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                                            setLabDraft(await sandboxHealthLabDocument(healthConfigId, base64));
                                          });
                                        reader.readAsDataURL(f);
                                      }}
                                    />
                                  )}
                                  {healthBusy === 'ocr' && <p className="muted">Распознаём…</p>}
                                  {labDraft && (
                                    <div style={{ marginTop: 6 }}>
                                      <div className="muted" style={{ fontSize: 12 }}>
                                        черновик <code>{labDraft.id}</code> ·{' '}
                                        {labDraft.verified ? <span className="badge badge-ok">подтверждён</span> : 'не подтверждён (verified: false)'}
                                      </div>
                                      <pre style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, marginTop: 4 }}>{labDraft.ocrText || '(текст не распознан)'}</pre>
                                      {!labDraft.verified && (
                                        <button
                                          type="button"
                                          disabled={healthBusy !== null}
                                          onClick={() =>
                                            withHealth('verify', async () => {
                                              const r = await sandboxHealthLabVerify(labDraft.id);
                                              setLabDraft({ ...labDraft, verified: r.verified });
                                            })
                                          }
                                        >
                                          {healthBusy === 'verify' ? 'Подтверждаем…' : 'Подтвердить (verify)'}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {healthError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{healthError}</p>}
                      </div>
                    )}

                    {/* Пункт [sandbox-major-purchase] 2026-09-01 — этап 1
                        доменного покрытия: цикл крупной покупки до
                        сравнительной таблицы, продовыми сервисами. */}
                    {intakeState.chosenScenario === 'major-purchase' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг крупной покупки</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Ответы квиза уже перенесены в разговор. Выберите категорию, при желании добавьте
                          деталей (бюджет, критерии) — «Чек-лист» и «Извлечь конфиг» — реальные LLM-вызовы.
                        </p>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                          <select value={mpCategory} onChange={(e) => setMpCategory(e.target.value as 'REAL_ESTATE' | 'VEHICLE')} disabled={mpDraft !== null}>
                            <option value="VEHICLE">Автомобиль</option>
                            <option value="REAL_ESTATE">Недвижимость</option>
                          </select>
                          <button
                            type="button"
                            disabled={mpBusy !== null}
                            onClick={() =>
                              withMp('checklist', async () => {
                                const r = await sandboxMpChecklist(intakeState.conversationId as string, mpCategory);
                                setMpChecklistItems(r.items);
                              })
                            }
                          >
                            {mpBusy === 'checklist' ? 'Генерируем…' : 'Чек-лист тем (AI)'}
                          </button>
                        </div>
                        {mpChecklistItems && (
                          <ul style={{ margin: '6px 0', fontSize: 13 }}>
                            {mpChecklistItems.map((c, i) => <li key={i}>{c}</li>)}
                          </ul>
                        )}
                        {!mpDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={mpAnswerText}
                              onChange={(e) => setMpAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={mpBusy !== null || !mpAnswerText.trim()}
                              onClick={() =>
                                withMp('answer', async () => {
                                  await sandboxMpAnswer(intakeState.conversationId as string, mpAnswerText);
                                  setMpAnswerText('');
                                })
                              }
                            >
                              {mpBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={mpBusy !== null}
                              onClick={() =>
                                withMp('extract', async () => {
                                  setMpDraft(await sandboxMpExtract(intakeState.conversationId as string, mpCategory));
                                })
                              }
                            >
                              {mpBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {mpDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>Черновик конфига:</b> {mpDraft.goalDescription}</div>
                            <div className="muted" style={{ fontSize: 13 }}>
                              {mpDraft.budgetMin !== null || mpDraft.budgetMax !== null ? (
                                <>бюджет: {mpDraft.budgetMin ?? '…'}–{mpDraft.budgetMax ?? '…'} {mpDraft.currency ?? ''}</>
                              ) : 'бюджет не назван'}
                              {mpDraft.financingMethod && <> · финансирование: {mpDraft.financingMethod}</>}
                              {mpDraft.timeline && <> · сроки: {mpDraft.timeline}</>}
                            </div>
                            <ul style={{ margin: '6px 0' }}>
                              {mpDraft.criteria.map((c, i) => (
                                <li key={i}>{c.text}{c.isRequired && <span className="muted"> · обязательный</span>}</li>
                              ))}
                            </ul>
                            {!mpConfigId ? (
                              <button
                                type="button"
                                disabled={mpBusy !== null}
                                onClick={() =>
                                  withMp('config', async () => {
                                    const res = await sandboxMpConfig(
                                      (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                      mpCategory,
                                      mpDraft,
                                    );
                                    setMpConfigId(res.id);
                                  })
                                }
                              >
                                {mpBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span> <code>{mpConfigId}</code>
                                <span className="muted"> — воронка major-purchase дошла до «С конфигом»</span>

                                {/* Варианты + сравнительная таблица — «жемчужина»
                                    домена: ради неё он и выбран первым. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Варианты</b>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <input
                                      type="text"
                                      value={mpVariantLabel}
                                      onChange={(e) => setMpVariantLabel(e.target.value)}
                                      placeholder="Название варианта (например «Octavia 2019, серая»)…"
                                      style={{ flex: '1 1 280px' }}
                                    />
                                    <input
                                      type="number"
                                      value={mpVariantPrice}
                                      onChange={(e) => setMpVariantPrice(e.target.value)}
                                      placeholder="Цена (необязательно)"
                                      style={{ width: 160 }}
                                    />
                                    <button
                                      type="button"
                                      disabled={mpBusy !== null || !mpVariantLabel.trim()}
                                      onClick={() =>
                                        withMp('variant', async () => {
                                          await sandboxMpVariant(
                                            mpConfigId,
                                            mpVariantLabel,
                                            mpVariantPrice ? Number(mpVariantPrice) : undefined,
                                            mpVariantPrice ? (mpDraft.currency ?? 'UAH') : undefined,
                                          );
                                          setMpVariantLabel('');
                                          setMpVariantPrice('');
                                          setMpComparison(await sandboxMpComparison(mpConfigId));
                                        })
                                      }
                                    >
                                      {mpBusy === 'variant' ? 'Добавляем…' : 'Добавить вариант'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={mpBusy !== null}
                                      onClick={() => withMp('comparison', async () => setMpComparison(await sandboxMpComparison(mpConfigId)))}
                                    >
                                      {mpBusy === 'comparison' ? 'Строим…' : 'Сравнительная таблица'}
                                    </button>
                                  </div>
                                  {mpComparison && (
                                    <div style={{ marginTop: 8, overflowX: 'auto' }}>
                                      {mpComparison.variants.length === 0 ? (
                                        <p className="muted">Вариантов пока нет — добавьте первый выше.</p>
                                      ) : (
                                        <table style={{ fontSize: 13 }}>
                                          <thead>
                                            <tr><th>Вариант</th><th>Цена</th><th>Сравнений</th><th>AI-заключение</th></tr>
                                          </thead>
                                          <tbody>
                                            {mpComparison.variants.map((v) => (
                                              <tr key={v.id}>
                                                <td>{v.label}{v.placeName && <span className="muted"> · {v.placeName}</span>}</td>
                                                <td>{v.askingPrice !== null ? `${v.askingPrice} ${v.currency ?? ''}` : '—'}</td>
                                                <td>{v.comparisonCount}</td>
                                                <td className="muted" style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>
                                                  {v.latestConclusion ?? 'нет встреч — заключение появится после generate-conclusion (следующий подэтап)'}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      )}
                                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                        Критериев в конфиге: {mpComparison.criteria.length}. Разбор по критериям
                                        заполняется AI-заключением встречи с продавцом — подэтап b ниже.
                                      </p>
                                    </div>
                                  )}
                                </div>
                                {renderBStep({
                                  projectId: (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                  label: 'Крупная покупка — встреча с продавцом',
                                  runLabel: 'Встреча → AI-заключение (1b)',
                                  disabledReason: !mpComparison || mpComparison.variants.length === 0 ? 'Сначала добавьте вариант — встреча привязывается к первому из них' : null,
                                  onRun: async (convId) => {
                                    const r = await sandboxMpMeetingConclusion((mpComparison as SandboxMpComparison).variants[0].id, convId);
                                    setMpComparison(await sandboxMpComparison(mpConfigId));
                                    return { summary: r.conclusionDraft ?? 'заключение готово (без вердикта «покупать/не покупать» — граница §5.5)', breakdown: r.criteriaBreakdown };
                                  },
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {mpError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{mpError}</p>}
                      </div>
                    )}

                    {/* Пункт [sandbox-investment] 2026-09-01 — этап 2
                        доменного покрытия: инвестиции до сравнительной
                        таблицы (без score/rank — продовая граница) +
                        смоук групповой механики. */}
                    {intakeState.chosenScenario === 'investment' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг инвестиций</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Ответы квиза уже перенесены. Добавьте детали (бюджет, что смущает в предложении)
                          и нажмите «Извлечь конфиг» — реальный LLM-вызов.
                        </p>
                        {!invDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={invAnswerText}
                              onChange={(e) => setInvAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={invBusy !== null || !invAnswerText.trim()}
                              onClick={() =>
                                withInv('answer', async () => {
                                  await sandboxInvAnswer(intakeState.conversationId as string, invAnswerText);
                                  setInvAnswerText('');
                                })
                              }
                            >
                              {invBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={invBusy !== null}
                              onClick={() =>
                                withInv('extract', async () => {
                                  setInvDraft(await sandboxInvExtract(intakeState.conversationId as string));
                                })
                              }
                            >
                              {invBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {invDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>Черновик конфига:</b> {invDraft.goalDescription}</div>
                            {invDraft.targetBudget !== null && (
                              <div className="muted" style={{ fontSize: 13 }}>бюджет: {invDraft.targetBudget} {invDraft.currency ?? ''}</div>
                            )}
                            <ul style={{ margin: '6px 0' }}>
                              {invDraft.criteria.map((c, i) => (
                                <li key={i}>
                                  <span className="badge badge-pending">{c.category}</span> {c.text}
                                  {c.isRequired && <span className="muted"> · обязательный</span>}
                                </li>
                              ))}
                            </ul>
                            {!invConfigId ? (
                              <button
                                type="button"
                                disabled={invBusy !== null}
                                onClick={() =>
                                  withInv('config', async () => {
                                    const res = await sandboxInvConfig(
                                      (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                      invDraft,
                                    );
                                    setInvConfigId(res.id);
                                  })
                                }
                              >
                                {invBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span> <code>{invConfigId}</code>
                                <span className="muted"> — воронка investment дошла до «С конфигом»</span>

                                <div style={{ marginTop: 10 }}>
                                  <b>Инвестиционная возможность</b>
                                  {!invOppId ? (
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                      <input
                                        type="text"
                                        value={invOppLabel}
                                        onChange={(e) => setInvOppLabel(e.target.value)}
                                        placeholder="Название (например «Фонд Х, 30% годовых»)…"
                                        style={{ flex: '1 1 280px' }}
                                      />
                                      <input
                                        type="text"
                                        value={invOppAdvisor}
                                        onChange={(e) => setInvOppAdvisor(e.target.value)}
                                        placeholder="Советник (необязательно)"
                                        style={{ width: 200 }}
                                      />
                                      <button
                                        type="button"
                                        disabled={invBusy !== null || !invOppLabel.trim()}
                                        onClick={() =>
                                          withInv('opp', async () => {
                                            const o = await sandboxInvOpportunity(invConfigId, invOppLabel, invOppAdvisor || undefined);
                                            setInvOppId(o.id);
                                            setInvComparison(await sandboxInvComparison(invConfigId));
                                          })
                                        }
                                      >
                                        {invBusy === 'opp' ? 'Добавляем…' : 'Добавить возможность'}
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ marginTop: 6 }}>
                                      <span className="badge badge-ok">ДОБАВЛЕНА</span> <code>{invOppId}</code>
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                        <input
                                          type="text"
                                          value={invSourceUrl}
                                          onChange={(e) => setInvSourceUrl(e.target.value)}
                                          placeholder="URL источника для сравнения (проспект фонда, статья)…"
                                          style={{ flex: '1 1 320px' }}
                                        />
                                        <button
                                          type="button"
                                          disabled={invBusy !== null || !invSourceUrl.trim()}
                                          onClick={() =>
                                            withInv('source', async () => {
                                              setInvSourceResult(await sandboxInvSourceComparison(invOppId, invSourceUrl));
                                              setInvComparison(await sandboxInvComparison(invConfigId));
                                            })
                                          }
                                        >
                                          {invBusy === 'source' ? 'Скачиваем…' : 'Сравнить с источником'}
                                        </button>
                                      </div>
                                      {invSourceResult && (
                                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                          Скачано {invSourceResult.sourceTextLength} символов из {invSourceResult.sourceUrl} — сырой текст
                                          сохранён для собственного прочтения, AI-оценки «выгодности» нет намеренно (граница §3.2).
                                          <pre style={{ maxHeight: 120, overflow: 'auto', marginTop: 4 }}>{invSourceResult.sourceTextPreview}</pre>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {invComparison && (
                                    <div style={{ marginTop: 8, overflowX: 'auto' }}>
                                      <table style={{ fontSize: 13 }}>
                                        <thead><tr><th>Возможность</th><th>Советник</th><th>Встреч</th><th>Сравнений</th></tr></thead>
                                        <tbody>
                                          {invComparison.opportunities.map((o) => (
                                            <tr key={o.id}>
                                              <td>{o.label}</td>
                                              <td>{o.advisorName ?? '—'}{o.advisorCompany && ` (${o.advisorCompany})`}</td>
                                              <td>{o.meetingsCount}</td>
                                              <td>{o.comparisonCount}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                        Критериев: {invComparison.criteria.length}. Score/rank отсутствуют намеренно —
                                        продовая граница, не упрощение песочницы. Разбор встречи (generate-breakdown) —
                                        подэтап 2b, нужен записанный разговор.
                                      </p>
                                    </div>
                                  )}
                                </div>

                                {invOppId &&
                                  renderBStep({
                                    projectId: (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                    label: 'Инвестиции — встреча с советником',
                                    runLabel: 'Встреча → нейтральный разбор (2b)',
                                    onRun: async (convId) => {
                                      const r = await sandboxInvMeetingBreakdown(invOppId, convId);
                                      setInvComparison(await sandboxInvComparison(invConfigId));
                                      return { summary: 'разбор по критериям готов (без оценки выгодности — граница §3.2/3.3)', breakdown: r.criteriaBreakdown };
                                    },
                                  })}

                                <div style={{ marginTop: 10 }}>
                                  <b>Группа соинвесторов (смоук)</b>
                                  {!invGroupResult ? (
                                    <div style={{ marginTop: 6 }}>
                                      <button
                                        type="button"
                                        disabled={invBusy !== null}
                                        onClick={() => withInv('group', async () => setInvGroupResult(await sandboxInvGroupSmoke()))}
                                      >
                                        {invBusy === 'group' ? 'Прогоняем…' : 'Смоук: группа → инвайт → pledge'}
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 13, marginTop: 6 }}>
                                      <span className="badge badge-ok">OK</span> группа <code>{invGroupResult.groupId}</code> ·
                                      инвайт выпущен: {invGroupResult.inviteTokenIssued ? 'да' : 'нет'} ·
                                      повторный вход идемпотентен: {invGroupResult.rejoinIdempotent ? 'да' : 'нет'} ·
                                      pledge: {invGroupResult.pledgedAmount} · моих групп: {invGroupResult.myGroupsCount}
                                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{invGroupResult.notes}</div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {invError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{invError}</p>}
                      </div>
                    )}

                    {/* Пункт [sandbox-interview-pool] 2026-09-01 — этап 3
                        доменного покрытия: подбор персонала до сводного
                        отчёта. Compliance-флаги — «жемчужина» домена. */}
                    {intakeState.chosenScenario === 'interview-pool' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг подбора персонала</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Опишите вакансию (можно с сомнительными требованиями — «до 35 лет», «только мужчины»:
                          extract подсветит их compliance-флагами с цитатой, не вычистит молча). Extract — реальный LLM-вызов.
                        </p>
                        {!ipDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={ipAnswerText}
                              onChange={(e) => setIpAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ про вакансию (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={ipBusy !== null || !ipAnswerText.trim()}
                              onClick={() =>
                                withIp('answer', async () => {
                                  await sandboxIpAnswer(intakeState.conversationId as string, ipAnswerText);
                                  setIpAnswerText('');
                                })
                              }
                            >
                              {ipBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={ipBusy !== null}
                              onClick={() =>
                                withIp('extract', async () => {
                                  setIpDraft(await sandboxIpExtract(intakeState.conversationId as string));
                                })
                              }
                            >
                              {ipBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {ipDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>{ipDraft.jobTitle}</b> {ipDraft.salaryRange && <span className="muted">· {ipDraft.salaryRange}</span>}</div>
                            <div className="muted" style={{ fontSize: 13 }}>{ipDraft.extendedDescription.slice(0, 240)}</div>
                            {ipDraft.interviewStages.length > 0 && (
                              <div style={{ fontSize: 13, marginTop: 4 }}>
                                Этапы: {ipDraft.interviewStages.map((s) => s.name).join(' → ')}
                              </div>
                            )}
                            {ipDraft.complianceFlags.length > 0 && (
                              <div style={{ marginTop: 6 }}>
                                {ipDraft.complianceFlags.map((f, i) => (
                                  <div key={i}>
                                    <span className="badge badge-bad">compliance: {f.category}</span>{' '}
                                    <span className="muted" style={{ fontSize: 12 }}>«{f.quotedText}»</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {!ipConfigDone ? (
                              <button
                                type="button"
                                disabled={ipBusy !== null}
                                onClick={() =>
                                  withIp('config', async () => {
                                    await sandboxIpConfig((intakeState.projectId ?? intakeState.dispatchedProjectId) as string, ipDraft);
                                    setIpConfigDone(true);
                                  })
                                }
                                style={{ marginTop: 6 }}
                              >
                                {ipBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div style={{ marginTop: 6 }}>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span>
                                <span className="muted"> — воронка interview-pool дошла до «С конфигом»</span>

                                {/* Анкета: AI предлагает, человек утверждает. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Анкета пула</b>
                                  {!ipQuestionnaire ? (
                                    <div style={{ marginTop: 6 }}>
                                      <button
                                        type="button"
                                        disabled={ipBusy !== null}
                                        onClick={() =>
                                          withIp('qdraft', async () => {
                                            const r = await sandboxIpQuestionnaireDraft((intakeState.projectId ?? intakeState.dispatchedProjectId) as string);
                                            setIpQuestionnaire(r.items);
                                          })
                                        }
                                      >
                                        {ipBusy === 'qdraft' ? 'Генерируем…' : 'Сгенерировать анкету (AI)'}
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ marginTop: 6 }}>
                                      <ul style={{ margin: '4px 0', fontSize: 13 }}>
                                        {ipQuestionnaire.slice(0, 12).map((q, i) => (
                                          <li key={i}>{q.text}{q.isRequired && <span className="muted"> · обязательный</span>}</li>
                                        ))}
                                        {ipQuestionnaire.length > 12 && <li className="muted">…и ещё {ipQuestionnaire.length - 12}</li>}
                                      </ul>
                                      {!ipQuestionnaireFixed ? (
                                        <button
                                          type="button"
                                          disabled={ipBusy !== null}
                                          onClick={() =>
                                            withIp('qfix', async () => {
                                              await sandboxIpQuestionnaireFix((intakeState.projectId ?? intakeState.dispatchedProjectId) as string, ipQuestionnaire);
                                              setIpQuestionnaireFixed(true);
                                            })
                                          }
                                        >
                                          {ipBusy === 'qfix' ? 'Фиксируем…' : 'Зафиксировать анкету (человек утверждает)'}
                                        </button>
                                      ) : (
                                        <span className="badge badge-ok">АНКЕТА ЗАФИКСИРОВАНА</span>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Кандидаты + релевантность + отчёт. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Кандидаты</b>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <input
                                      type="text"
                                      value={ipCandidateName}
                                      onChange={(e) => setIpCandidateName(e.target.value)}
                                      placeholder="Имя кандидата…"
                                      style={{ width: 200 }}
                                    />
                                    <input
                                      type="text"
                                      value={ipCandidateResume}
                                      onChange={(e) => setIpCandidateResume(e.target.value)}
                                      placeholder="Резюме одной строкой (необязательно)"
                                      style={{ flex: '1 1 260px' }}
                                    />
                                    <button
                                      type="button"
                                      disabled={ipBusy !== null || !ipCandidateName.trim()}
                                      onClick={() =>
                                        withIp('candidate', async () => {
                                          await sandboxIpCandidate(
                                            (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                            ipCandidateName,
                                            ipCandidateResume || undefined,
                                          );
                                          setIpCandidates((l) => [...l, ipCandidateName]);
                                          setIpCandidateName('');
                                          setIpCandidateResume('');
                                        })
                                      }
                                    >
                                      {ipBusy === 'candidate' ? 'Добавляем…' : 'Добавить в пул'}
                                    </button>
                                  </div>
                                  {ipCandidates.length > 0 && (
                                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>В пуле: {ipCandidates.join(', ')}</div>
                                  )}
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                                    <button
                                      type="button"
                                      disabled={ipBusy !== null || !ipQuestionnaireFixed}
                                      title={!ipQuestionnaireFixed ? 'Сначала зафиксируйте анкету — релевантность сравнивает с ней' : undefined}
                                      onClick={() =>
                                        withIp('relevance', async () => {
                                          setIpRelevanceRes(await sandboxIpRelevance((intakeState.projectId ?? intakeState.dispatchedProjectId) as string));
                                        })
                                      }
                                    >
                                      {ipBusy === 'relevance' ? 'Оцениваем…' : 'Пересчитать релевантность (AI)'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={ipBusy !== null}
                                      onClick={() =>
                                        withIp('report', async () => {
                                          setIpReport(await sandboxIpSummaryReport((intakeState.projectId ?? intakeState.dispatchedProjectId) as string));
                                        })
                                      }
                                    >
                                      {ipBusy === 'report' ? 'Формируем…' : 'Сводный отчёт'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={ipBusy !== null}
                                      onClick={() => withIp('team', async () => setIpTeamRes(await sandboxIpTeamSmoke()))}
                                    >
                                      {ipBusy === 'team' ? 'Прогоняем…' : 'Смоук команды'}
                                    </button>
                                  </div>
                                  {ipRelevanceRes && (
                                    <div style={{ fontSize: 13, marginTop: 6 }}>
                                      {ipRelevanceRes.note ? (
                                        <span className="muted">{ipRelevanceRes.note}</span>
                                      ) : (
                                        ipRelevanceRes.entries.map((e, i) => (
                                          <div key={i}>
                                            <b>{e.candidate}</b>
                                            {e.attentionPoints.length > 0 && <span className="muted"> · внимание: {e.attentionPoints.join('; ')}</span>}
                                            {e.followUpRequestsDraft.length > 0 && <span className="muted"> · дозапросить: {e.followUpRequestsDraft.join('; ')}</span>}
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  )}
                                  {ipReport && (
                                    <div style={{ fontSize: 13, marginTop: 6 }}>
                                      <span className="badge badge-ok">ОТЧЁТ</span> кандидатов: {ipReport.content.funnel.totalCandidates} ·{' '}
                                      {Object.entries(ipReport.content.funnel.byStage).filter(([, n]) => n > 0).map(([s, n]) => `${s}: ${n}`).join(' · ')}
                                      {ipReport.content.entries.map((e) => (
                                        <div key={e.candidateProfileId} className="muted" style={{ fontSize: 12 }}>
                                          {e.displayName} — покрытие обязательных вопросов: {Math.round(e.coverageScore * 100)}% (прозрачная метрика, не AI-балл)
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {ipTeamRes && (
                                    <div style={{ fontSize: 13, marginTop: 6 }}>
                                      <span className="badge badge-ok">OK</span> команда <code>{ipTeamRes.teamId}</code> ·
                                      инвайт: {ipTeamRes.inviteTokenIssued ? 'да' : 'нет'} · повторный вход идемпотентен: {ipTeamRes.rejoinIdempotent ? 'да' : 'нет'} ·
                                      моих команд: {ipTeamRes.myTeamsCount}
                                      <div className="muted" style={{ fontSize: 12 }}>{ipTeamRes.notes}</div>
                                    </div>
                                  )}
                                  {renderBStep({
                                    projectId: (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                    label: 'Подбор персонала — интервью кандидата',
                                    runLabel: 'Привязать интервью (3b)',
                                    disabledReason: ipCandidates.length === 0 ? 'Сначала добавьте кандидата — интервью привязывается к нему' : null,
                                    onRun: async (convId) => {
                                      const r = await sandboxIpAttachInterview((intakeState.projectId ?? intakeState.dispatchedProjectId) as string, convId);
                                      return { summary: `привязано к стадии «${r.stageName}». ${r.note}`, breakdown: null };
                                    },
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {ipError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{ipError}</p>}
                      </div>
                    )}

                    {/* Пункт [sandbox-family-law] 2026-09-01 — этап 4
                        доменного покрытия: до черновика протокола
                        урегулирования (дисклеймер §3.6 — из прода). */}
                    {intakeState.chosenScenario === 'family-law' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг семейного права</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Тип договора уже передан при dispatch. Добавьте детали (что делить, бюджет на
                          юристов) — «Извлечь конфиг» — реальный LLM-вызов.
                        </p>
                        {!flDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={flAnswerText}
                              onChange={(e) => setFlAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={flBusy !== null || !flAnswerText.trim()}
                              onClick={() =>
                                withFl('answer', async () => {
                                  await sandboxFlAnswer(intakeState.conversationId as string, flAnswerText);
                                  setFlAnswerText('');
                                })
                              }
                            >
                              {flBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={flBusy !== null}
                              onClick={() =>
                                withFl('extract', async () => {
                                  setFlDraft(await sandboxFlExtract(intakeState.conversationId as string));
                                })
                              }
                            >
                              {flBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {flDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>Черновик конфига:</b> {flDraft.goalDescription}</div>
                            {flDraft.targetBudget !== null && (
                              <div className="muted" style={{ fontSize: 13 }}>бюджет: {flDraft.targetBudget} {flDraft.currency ?? ''}</div>
                            )}
                            <ul style={{ margin: '6px 0' }}>
                              {flDraft.criteria.map((c, i) => (
                                <li key={i}>
                                  <span className="badge badge-pending">{c.category}</span> {c.text}
                                  {c.isRequired && <span className="muted"> · обязательный</span>}
                                </li>
                              ))}
                            </ul>
                            {!flConfigId ? (
                              <button
                                type="button"
                                disabled={flBusy !== null}
                                onClick={() =>
                                  withFl('config', async () => {
                                    const res = await sandboxFlConfig(
                                      (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                      flDraft,
                                    );
                                    setFlConfigId(res.id);
                                  })
                                }
                              >
                                {flBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span> <code>{flConfigId}</code>
                                <span className="muted"> — воронка family-law дошла до «С конфигом»</span>

                                {/* Стороны и активы — реестр §3.1/§3.3. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Стороны и активы</b>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <select value={flPartyRole} onChange={(e) => setFlPartyRole(e.target.value as 'SELF' | 'SPOUSE')}>
                                      <option value="SELF">SELF (я)</option>
                                      <option value="SPOUSE">SPOUSE (супруг/а)</option>
                                    </select>
                                    <input
                                      type="text"
                                      value={flPartyName}
                                      onChange={(e) => setFlPartyName(e.target.value)}
                                      placeholder="Имя (необязательно)"
                                      style={{ width: 180 }}
                                    />
                                    <button
                                      type="button"
                                      disabled={flBusy !== null}
                                      onClick={() =>
                                        withFl('party', async () => {
                                          await sandboxFlParty(flConfigId, flPartyRole, flPartyName || undefined);
                                          setFlParties((l) => [...l, `${flPartyRole}${flPartyName ? ` (${flPartyName})` : ''}`]);
                                          setFlPartyName('');
                                        })
                                      }
                                    >
                                      {flBusy === 'party' ? 'Добавляем…' : 'Добавить сторону'}
                                    </button>
                                  </div>
                                  {flParties.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Стороны: {flParties.join(', ')}</div>}
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <input
                                      type="text"
                                      value={flAssetType}
                                      onChange={(e) => setFlAssetType(e.target.value)}
                                      placeholder="Актив (например «квартира», «авто»)…"
                                      style={{ flex: '1 1 220px' }}
                                    />
                                    <input
                                      type="number"
                                      value={flAssetValue}
                                      onChange={(e) => setFlAssetValue(e.target.value)}
                                      placeholder="Оценка (необязательно)"
                                      style={{ width: 170 }}
                                    />
                                    <button
                                      type="button"
                                      disabled={flBusy !== null || !flAssetType.trim()}
                                      onClick={() =>
                                        withFl('asset', async () => {
                                          await sandboxFlAsset(flConfigId, flAssetType, flAssetValue ? Number(flAssetValue) : undefined, flAssetValue ? 'UAH' : undefined);
                                          setFlAssets((l) => [...l, flAssetType]);
                                          setFlAssetType('');
                                          setFlAssetValue('');
                                        })
                                      }
                                    >
                                      {flBusy === 'asset' ? 'Добавляем…' : 'Добавить актив'}
                                    </button>
                                  </div>
                                  {flAssets.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Активы: {flAssets.join(', ')}</div>}
                                </div>

                                {/* Бюджет §3.4 — строки расход/покрытие, свод по валютам. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Бюджет</b>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <select value={flBudgetCategory} onChange={(e) => setFlBudgetCategory(e.target.value)}>
                                      {['LEGAL_FEES', 'ASSET_TRANSFER', 'SUPPORT_PAYMENT', 'OTHER'].map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    <select value={flBudgetDirection} onChange={(e) => setFlBudgetDirection(e.target.value)}>
                                      <option value="EXPENSE">расход</option>
                                      <option value="COVERAGE">покрытие</option>
                                    </select>
                                    <input
                                      type="number"
                                      value={flBudgetAmount}
                                      onChange={(e) => setFlBudgetAmount(e.target.value)}
                                      placeholder="Сумма"
                                      style={{ width: 140 }}
                                    />
                                    <button
                                      type="button"
                                      disabled={flBusy !== null || !flBudgetAmount}
                                      onClick={() =>
                                        withFl('budget', async () => {
                                          setFlBudget(await sandboxFlBudgetItem(flConfigId, flBudgetCategory, flBudgetDirection, Number(flBudgetAmount), 'UAH'));
                                          setFlBudgetAmount('');
                                        })
                                      }
                                    >
                                      {flBusy === 'budget' ? 'Добавляем…' : 'Добавить строку'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={flBusy !== null}
                                      onClick={() => withFl('draft', async () => setFlSettlement(await sandboxFlSettlementDraft(flConfigId)))}
                                    >
                                      {flBusy === 'draft' ? 'Компилируем…' : 'Черновик протокола урегулирования'}
                                    </button>
                                  </div>
                                  {flBudget && (
                                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                      {flBudget.byCurrency.map((b) => `${b.currency}: расходы ${b.totalExpense}, покрытие ${b.totalCoverage}, нетто ${b.netBudget}`).join(' · ')}
                                      {flBudget.targetBudget !== null && ` · целевой бюджет: ${flBudget.targetBudget} ${flBudget.currency ?? ''}`}
                                    </div>
                                  )}
                                  {flSettlement && (
                                    <div style={{ marginTop: 8 }}>
                                      <span className="badge badge-pending">черновик-компиляция, НЕ юридический документ</span>
                                      <pre style={{ maxHeight: 220, overflow: 'auto', fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>{flSettlement.text}</pre>
                                    </div>
                                  )}
                                </div>
                                {renderBStep({
                                  projectId: (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                  label: 'Семейное право — консультация юриста',
                                  runLabel: 'Консультация → AI-разбор (4b)',
                                  onRun: async (convId) => {
                                    const r = await sandboxFlConsultationBreakdown(flConfigId, convId, 'Песочный юрист');
                                    return { summary: `консультация ${r.consultationId} разобрана по критериям конфига`, breakdown: r.criteriaBreakdown };
                                  },
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {flError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{flError}</p>}
                      </div>
                    )}

                    {/* Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного
                        покрытия: до реестра доказательств (chain of
                        custody) и черновика протокола. */}
                    {intakeState.chosenScenario === 'dtp' && intakeState.conversationId && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2a2f3a)', paddingTop: 10 }}>
                        <b>Онбординг ДТП</b>
                        <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                          Опишите аварию (кто виноват по протоколу, что со страховой) — «Извлечь конфиг» —
                          реальный LLM-вызов.
                        </p>
                        {!dtpDraft && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={dtpAnswerText}
                              onChange={(e) => setDtpAnswerText(e.target.value)}
                              placeholder="Дополнительный ответ (необязательно)…"
                              style={{ flex: '1 1 320px' }}
                            />
                            <button
                              type="button"
                              disabled={dtpBusy !== null || !dtpAnswerText.trim()}
                              onClick={() =>
                                withDtp('answer', async () => {
                                  await sandboxDtpAnswer(intakeState.conversationId as string, dtpAnswerText);
                                  setDtpAnswerText('');
                                })
                              }
                            >
                              {dtpBusy === 'answer' ? 'Добавляем…' : 'Добавить ответ'}
                            </button>
                            <button
                              type="button"
                              disabled={dtpBusy !== null}
                              onClick={() =>
                                withDtp('extract', async () => {
                                  setDtpDraft(await sandboxDtpExtract(intakeState.conversationId as string));
                                })
                              }
                            >
                              {dtpBusy === 'extract' ? 'Извлекаем…' : 'Извлечь конфиг (extract)'}
                            </button>
                          </div>
                        )}
                        {dtpDraft && (
                          <div style={{ marginTop: 8 }}>
                            <div><b>Черновик конфига:</b> {dtpDraft.goalDescription}</div>
                            <div className="muted" style={{ fontSize: 13 }}>
                              {dtpDraft.occurredAt && <>дата ДТП: {dtpDraft.occurredAt} · </>}
                              {dtpDraft.targetBudget !== null ? <>бюджет: {dtpDraft.targetBudget} {dtpDraft.currency ?? ''}</> : 'бюджет не назван'}
                            </div>
                            <ul style={{ margin: '6px 0' }}>
                              {dtpDraft.criteria.map((c, i) => (
                                <li key={i}>
                                  <span className="badge badge-pending">{c.category}</span> {c.text}
                                  {c.isRequired && <span className="muted"> · обязательный</span>}
                                </li>
                              ))}
                            </ul>
                            {!dtpConfigId ? (
                              <button
                                type="button"
                                disabled={dtpBusy !== null}
                                onClick={() =>
                                  withDtp('config', async () => {
                                    const res = await sandboxDtpConfig(
                                      (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                      dtpDraft,
                                    );
                                    setDtpConfigId(res.id);
                                  })
                                }
                              >
                                {dtpBusy === 'config' ? 'Создаём…' : 'Создать конфиг'}
                              </button>
                            ) : (
                              <div>
                                <span className="badge badge-ok">КОНФИГ СОЗДАН</span> <code>{dtpConfigId}</code>
                                <span className="muted"> — воронка dtp дошла до «С конфигом»</span>

                                <div style={{ marginTop: 10 }}>
                                  <b>Участники и вина</b>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <select value={dtpRole} onChange={(e) => setDtpRole(e.target.value as never)}>
                                      <option value="SELF">SELF (я)</option>
                                      <option value="OTHER_PARTY">OTHER_PARTY (вторая сторона)</option>
                                      <option value="THIRD_PARTY">THIRD_PARTY (третья)</option>
                                    </select>
                                    <button
                                      type="button"
                                      disabled={dtpBusy !== null}
                                      onClick={() =>
                                        withDtp('participant', async () => {
                                          await sandboxDtpParticipant(dtpConfigId, dtpRole);
                                          setDtpParticipants((l) => [...l, dtpRole]);
                                        })
                                      }
                                    >
                                      {dtpBusy === 'participant' ? 'Добавляем…' : 'Добавить участника'}
                                    </button>
                                  </div>
                                  {dtpParticipants.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Участники: {dtpParticipants.join(', ')}</div>}
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                    <select value={dtpFaultSource} onChange={(e) => setDtpFaultSource(e.target.value)}>
                                      {['POLICE', 'INSURANCE_COMPANY', 'COURT', 'MUTUAL_AGREEMENT', 'UNDETERMINED'].map((sName) => <option key={sName} value={sName}>{sName}</option>)}
                                    </select>
                                    <input
                                      type="text"
                                      value={dtpFaultText}
                                      onChange={(e) => setDtpFaultText(e.target.value)}
                                      placeholder="Формулировка (например «виновник признал вину, протокол №…»)…"
                                      style={{ flex: '1 1 280px' }}
                                    />
                                    <button
                                      type="button"
                                      disabled={dtpBusy !== null || !dtpFaultText.trim()}
                                      onClick={() =>
                                        withDtp('fault', async () => {
                                          await sandboxDtpFault(dtpConfigId, dtpFaultSource, dtpFaultText);
                                          setDtpFaultDone(true);
                                          setDtpFaultText('');
                                        })
                                      }
                                    >
                                      {dtpBusy === 'fault' ? 'Фиксируем…' : 'Зафиксировать вину'}
                                    </button>
                                    {dtpFaultDone && <span className="badge badge-ok">зафиксировано</span>}
                                  </div>
                                </div>

                                {/* Доказательства — chain of custody. */}
                                <div style={{ marginTop: 10 }}>
                                  <b>Доказательство (фото)</b>
                                  <p className="muted" style={{ margin: '4px 0 6px', fontSize: 12 }}>
                                    Реальная загрузка в приватное хранилище: sha256 считается сервером из
                                    содержимого, доступ пишется в append-only журнал. AI по доказательствам
                                    не вызывается никогда (§3.1/3.4). До ~3 МБ.
                                  </p>
                                  {!dtpEvidence ? (
                                    <input
                                      type="file"
                                      accept="image/*"
                                      disabled={dtpBusy !== null}
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (!f) return;
                                        const reader = new FileReader();
                                        reader.onload = () =>
                                          withDtp('evidence', async () => {
                                            const dataUrl = String(reader.result ?? '');
                                            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                                            setDtpEvidence(await sandboxDtpEvidence(dtpConfigId, base64, f.type || 'image/jpeg'));
                                          });
                                        reader.readAsDataURL(f);
                                      }}
                                    />
                                  ) : (
                                    <div style={{ fontSize: 13 }}>
                                      <span className="badge badge-ok">СОХРАНЕНО</span>{' '}
                                      sha256: <code style={{ fontSize: 11 }}>{dtpEvidence.fileHash.slice(0, 16)}…</code>
                                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                        Журнал доступа: {dtpEvidence.accessLog.map((l) => `${l.action} (${new Date(l.at).toLocaleTimeString('ru-RU')})`).join(' → ') || 'пуст'}
                                      </div>
                                    </div>
                                  )}
                                  {dtpBusy === 'evidence' && <p className="muted">Загружаем…</p>}
                                </div>

                                <div style={{ marginTop: 10 }}>
                                  <button
                                    type="button"
                                    disabled={dtpBusy !== null}
                                    onClick={() => withDtp('draft', async () => setDtpSettlement(await sandboxDtpSettlementDraft(dtpConfigId)))}
                                  >
                                    {dtpBusy === 'draft' ? 'Компилируем…' : 'Черновик протокола урегулирования'}
                                  </button>
                                  {dtpSettlement && (
                                    <div style={{ marginTop: 8 }}>
                                      <span className="badge badge-pending">черновик-компиляция, НЕ юридический документ</span>
                                      <pre style={{ maxHeight: 220, overflow: 'auto', fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>{dtpSettlement.text}</pre>
                                    </div>
                                  )}
                                </div>
                                {renderBStep({
                                  projectId: (intakeState.projectId ?? intakeState.dispatchedProjectId) as string,
                                  label: 'ДТП — консультация юриста',
                                  runLabel: 'Консультация → AI-разбор (5b)',
                                  onRun: async (convId) => {
                                    const r = await sandboxDtpConsultationBreakdown(dtpConfigId, convId, 'Песочный юрист');
                                    return { summary: `консультация ${r.consultationId} разобрана по критериям конфига`, breakdown: r.criteriaBreakdown };
                                  },
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {dtpError && <p style={{ color: 'var(--signal-critical)', marginTop: 6 }}>{dtpError}</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
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
          {queueTarget && (
            <p style={{ marginTop: 0 }}>
              Файл будет привязан к ролику: <strong>{queueTarget.title}</strong>{' '}
              <button type="button" onClick={() => setQueueTarget(null)} style={{ marginLeft: 8 }}>
                Отвязать
              </button>
            </p>
          )}
          {uploadTargetProject && (
            <p style={{ marginTop: 0 }}>
              <span className="badge badge-pending">b-подэтап</span> Разговор будет создан в доменном
              проекте: <strong>{uploadTargetProject.label}</strong>{' '}
              <button type="button" onClick={() => setUploadTargetProject(null)} style={{ marginLeft: 8 }}>
                Сбросить
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
