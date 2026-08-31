'use client';

// Пункт 13 (backend) → TMA UI: Conversation Dossier (раздел 2 ТЗ, MVP v2).
//
// Тот же паттерн, что PeopleSection: список + инлайн-форма добавления +
// разворачиваемая строка с деталями. Поток загрузки — выбор файла
// (нативный <input type="file">), не встроенная запись через
// MediaRecorder API: поддержка захвата аудио в Telegram WebView
// нестабильна между платформами (iOS/Android/Desktop) — честно
// оставлено как известное ограничение этого прохода, не притворяемся,
// что "запись" реализована. occurredAt по умолчанию — момент нажатия
// кнопки, не метаданные создания файла (раздел 2 ТЗ хочет именно
// последнее) — читать EXIF/media-метаданные на клиенте потребовало бы
// отдельной библиотеки, не тянется без сети в этой среде разработки;
// поле редактируемое, пользователь может поправить вручную.

import { useEffect, useState } from 'react';
import {
  assignParticipant,
  checkAgainstUserSource,
  checkAgainstFactCheckApi,
  confirmIntentionalFalsehood,
  createConversation,
  detectBestNextMove,
  detectDiscrepancies,
  detectDoNotSay,
  detectManipulationPatterns,
  detectTurningPoints,
  exportFactsToVerify,
  getConversation,
  getLatestBestNextMove,
  listConversations,
  listDiscrepancies,
  listDoNotSay,
  listManipulationPatterns,
  listPeople,
  listTurningPoints,
  requestTranscription,
  uploadConversationAudio,
} from '../lib/features';
import {
  BestNextMoveRecommendation,
  Conversation,
  ConversationDetail,
  ConversationSourceType,
  DiscrepancySignal,
  SourceCheckResult,
  FactCheckApiResult,
  FactsToVerifyExport,
  DoNotSayItem,
  ManipulationPoint,
  ProjectPersonLink,
  TurningPoint,
} from '../lib/types';
import { haptic } from '../lib/telegram';
import { AudioProcessingConsentPrompt, checkAudioProcessingConsent } from './AudioProcessingConsentPrompt';
import { SpeakButton } from './SpeakButton';
import { CooldownNudgeSession } from './CooldownNudgeSession';
import { LiveHintsSession } from './LiveHintsSession';
import { AssistanceScreen } from './AssistanceScreen';

interface ConversationsSectionProps {
  projectId: string;
}

const STATUS_LABELS: Record<string, string> = {
  UPLOADED: 'Загружено',
  TRANSCRIBING: 'Распознаём…',
  TRANSCRIBED: 'Расшифровано',
  ANALYZING: 'Анализируем…',
  ANALYZED: 'Проанализировано',
  FAILED: 'Ошибка обработки',
};

export function ConversationsSection({ projectId }: ConversationsSectionProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  function reload() {
    return listConversations(projectId)
      .then(setConversations)
      .catch(() => setConversations([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading) return null;

  return (
    <section className="conversations-section">
      <h3>Досье разговора</h3>

      {conversations.length === 0 && !showAddForm && (
        <p className="conversations-section__hint">
          Загрузите запись или файл разговора — расшифровка и разбор по репликам появятся здесь.
        </p>
      )}

      <CooldownNudgeSession projectId={projectId} />
      <LiveHintsSession projectId={projectId} />
      <AssistanceScreen projectId={projectId} />

      <ul className="conversations-list">
        {conversations.map((c) => (
          <ConversationRow key={c.id} conversation={c} projectId={projectId} onChanged={reload} />
        ))}
      </ul>

      {showAddForm ? (
        <AddConversationForm
          projectId={projectId}
          onDone={() => {
            setShowAddForm(false);
            reload();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      ) : (
        <button type="button" onClick={() => setShowAddForm(true)}>
          + Добавить разговор
        </button>
      )}
    </section>
  );
}

function AddConversationForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [sourceType, setSourceType] = useState<ConversationSourceType>('UPLOADED_AUDIO');
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<'idle' | 'creating' | 'uploading' | 'transcribing'>('idle');
  const [error, setError] = useState<string | null>(null);
  // ПОВТОРНЫЙ АУДИТ 2026-08-30: раньше форма отправляла файл сразу и
  // получала 403 от бэкенда, если согласия RECORDING/EPHEMERAL_SERVER
  // не выданы — а выдать их в TMA было негде вообще. Теперь гейт
  // показывается ДО загрузки: пользователь видит, что именно произойдёт
  // с файлом, а не сообщение об ошибке после нажатия кнопки.
  const [needsConsent, setNeedsConsent] = useState(false);

  const busy = step !== 'idle';

  async function handleSubmit() {
    if (!file) {
      setError('Выберите файл');
      return;
    }
    setError(null);

    if (!(await checkAudioProcessingConsent())) {
      setNeedsConsent(true);
      return;
    }

    try {
      setStep('creating');
      const conversation = await createConversation(projectId, {
        sourceType,
        occurredAt: new Date(occurredAt).toISOString(),
      });

      setStep('uploading');
      const { audioUrl } = await uploadConversationAudio(conversation.id, file);

      setStep('transcribing');
      await requestTranscription(conversation.id, { audioUrl });

      haptic('success');
      onDone();
    } catch (err) {
      haptic('error');
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось загрузить разговор — проверьте согласие на запись в Центре приватности',
      );
      setStep('idle');
    }
  }

  if (needsConsent) {
    return (
      <AudioProcessingConsentPrompt
        source="conversations-add-form"
        onGranted={() => {
          setNeedsConsent(false);
          void handleSubmit();
        }}
        onCancel={() => setNeedsConsent(false)}
      />
    );
  }

  return (
    <div className="conversations-section__add">
      <label>
        Тип источника
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as ConversationSourceType)}>
          <option value="UPLOADED_AUDIO">Загруженное аудио</option>
          <option value="UPLOADED_VIDEO">Загруженное видео</option>
          <option value="UPLOADED_PHOTO">Скриншот/фото переписки</option>
        </select>
      </label>

      <label>
        Когда состоялся разговор
        <input
          type="datetime-local"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
        />
      </label>

      <label>
        Файл
        <input
          type="file"
          accept="audio/*,video/*,image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <p className="conversations-section__privacy-note">
        Файл передаётся напрямую провайдеру расшифровки и не сохраняется на нашем сервере
        (раздел «Приватность» — центр приватности проекта).
      </p>

      {error && <p className="generation-error">{error}</p>}

      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleSubmit} disabled={busy || !file}>
          {step === 'idle' && 'Загрузить и расшифровать'}
          {step === 'creating' && 'Создаём запись…'}
          {step === 'uploading' && 'Загружаем файл…'}
          {step === 'transcribing' && 'Запускаем расшифровку…'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  projectId,
  onChanged,
}: {
  conversation: Conversation;
  projectId: string;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  useEffect(() => {
    if (!expanded) return;
    getConversation(conversation.id)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [expanded, conversation.id]);

  // Пункт 26: сопоставление диаризации фигурантам — список людей
  // проекта нужен для выпадающего списка, грузится один раз при
  // разворачивании, тем же паттерном, что CommitmentsSection.
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  useEffect(() => {
    if (!expanded) return;
    listPeople(projectId)
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [expanded, projectId]);

  async function handleAssignParticipant(participantId: string, value: string) {
    try {
      if (value === '__self__') {
        await assignParticipant(participantId, { isSelf: true });
      } else if (value) {
        await assignParticipant(participantId, { personId: value });
      }
      const refreshed = await getConversation(conversation.id);
      setDetail(refreshed);
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  // Разворачивающийся статус — если TRANSCRIBING, периодически
  // перепроверяем родительский список (пока не появится push/webhook
  // до клиента, что вне рамок этого прохода — polling самый простой
  // рабочий вариант, не идеальный).
  useEffect(() => {
    if (conversation.status !== 'TRANSCRIBING') return;
    const interval = setInterval(onChanged, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.status]);

  // Пункт 15: поворотные точки (§3.50 ТЗ) — загружаются вместе с
  // деталями, если разговор уже расшифрован (детекция доступна) или
  // уже проанализирован (результат уже есть).
  const [turningPoints, setTurningPoints] = useState<TurningPoint[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (conversation.status !== 'TRANSCRIBED' && conversation.status !== 'ANALYZED') return;
    listTurningPoints(conversation.id)
      .then(setTurningPoints)
      .catch(() => setTurningPoints([]));
  }, [expanded, conversation.id, conversation.status]);

  async function handleDetect() {
    setDetecting(true);
    setDetectError(null);
    try {
      await detectTurningPoints(conversation.id);
      const points = await listTurningPoints(conversation.id);
      setTurningPoints(points);
      onChanged(); // обновить статус разговора в родительском списке (TRANSCRIBED → ANALYZED)
      haptic('success');
    } catch (err) {
      haptic('error');
      setDetectError(err instanceof Error ? err.message : 'Не удалось найти поворотные точки');
    } finally {
      setDetecting(false);
    }
  }

  const turningPointsBySegment = new Map<string | null, TurningPoint>(
    turningPoints.map((tp): [string | null, TurningPoint] => [tp.transcriptSegmentId, tp]),
  );

  // Пункт 36: Manipulation Detector (§3.28 ТЗ, MVP v3) — та же
  // механика, что поворотные точки, но анализирует ОБОИХ говорящих
  // (не фильтрует по isSelf, в отличие от Do Not Say ниже) и не меняет
  // статус разговора (дополнительный детектор, не первичный анализ,
  // тот же принцип, что уже у Do Not Say).
  const [manipulationPoints, setManipulationPoints] = useState<ManipulationPoint[]>([]);
  const [detectingManipulation, setDetectingManipulation] = useState(false);
  const [manipulationError, setManipulationError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (conversation.status !== 'TRANSCRIBED' && conversation.status !== 'ANALYZED') return;
    listManipulationPatterns(conversation.id)
      .then(setManipulationPoints)
      .catch(() => setManipulationPoints([]));
  }, [expanded, conversation.id, conversation.status]);

  async function handleDetectManipulation() {
    setDetectingManipulation(true);
    setManipulationError(null);
    try {
      await detectManipulationPatterns(conversation.id);
      const points = await listManipulationPatterns(conversation.id);
      setManipulationPoints(points);
      haptic('success');
    } catch (err) {
      haptic('error');
      setManipulationError(err instanceof Error ? err.message : 'Не удалось проверить на манипулятивные приёмы');
    } finally {
      setDetectingManipulation(false);
    }
  }

  const manipulationBySegment = new Map<string | null, ManipulationPoint>(
    manipulationPoints.map((mp): [string | null, ManipulationPoint] => [mp.transcriptSegmentId, mp]),
  );

  // Пункт 37: Discrepancy Analysis (§3.16 ТЗ, MVP v3) — тот же паттерн,
  // что Manipulation Detector выше: не меняет статус разговора, не
  // фильтрует по isSelf (сверяет ОБОИХ говорящих, у каждого своя
  // "карточка"). Честно ограничена в объёме — см. комментарий в
  // discrepancy-analysis.service.ts, сверка с публичными фактами не
  // реализована (нужен внешний поиск, которого нет).
  const [discrepancies, setDiscrepancies] = useState<DiscrepancySignal[]>([]);
  const [detectingDiscrepancies, setDetectingDiscrepancies] = useState(false);
  const [discrepancyError, setDiscrepancyError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (conversation.status !== 'TRANSCRIBED' && conversation.status !== 'ANALYZED') return;
    listDiscrepancies(conversation.id)
      .then(setDiscrepancies)
      .catch(() => setDiscrepancies([]));
  }, [expanded, conversation.id, conversation.status]);

  async function handleDetectDiscrepancies() {
    setDetectingDiscrepancies(true);
    setDiscrepancyError(null);
    try {
      await detectDiscrepancies(conversation.id);
      const list = await listDiscrepancies(conversation.id);
      setDiscrepancies(list);
      haptic('success');
    } catch (err) {
      haptic('error');
      setDiscrepancyError(err instanceof Error ? err.message : 'Не удалось проверить на расхождения');
    } finally {
      setDetectingDiscrepancies(false);
    }
  }

  async function handleConfirmIntentional(signalId: string) {
    try {
      const updated = await confirmIntentionalFalsehood(signalId);
      setDiscrepancies((prev) => prev.map((d) => (d.id === signalId ? updated : d)));
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  const discrepancyBySegment = new Map<string | null, DiscrepancySignal>(
    discrepancies.map((d): [string | null, DiscrepancySignal] => [d.transcriptSegmentId, d]),
  );

  // Пункт 40: ручная проверка утверждения по ссылке, указанной
  // пользователем (четвёртый источник §3.16 ТЗ, не автономный поиск —
  // см. discrepancy-analysis.service.ts). Состояние по каждой реплике
  // отдельно (объект, не один общий флаг) — пользователь может
  // проверять разные реплики независимо, не только одну за раз.
  const [sourceCheckOpenFor, setSourceCheckOpenFor] = useState<string | null>(null);
  const [sourceCheckUrl, setSourceCheckUrl] = useState('');
  const [checkingSource, setCheckingSource] = useState(false);
  const [sourceCheckResults, setSourceCheckResults] = useState<Record<string, SourceCheckResult>>({});
  const [factCheckResults, setFactCheckResults] = useState<Record<string, FactCheckApiResult>>({});
  const [factCheckingId, setFactCheckingId] = useState<string | null>(null);
  const [factCheckError, setFactCheckError] = useState<string | null>(null);

  async function handleFactCheck(segmentId: string, claimText: string) {
    setFactCheckingId(segmentId);
    setFactCheckError(null);
    try {
      const result = await checkAgainstFactCheckApi(conversation.id, segmentId, claimText);
      setFactCheckResults((prev) => ({ ...prev, [segmentId]: result }));
      if (result.signal) setDiscrepancies(await listDiscrepancies(conversation.id));
      haptic(result.claims.length ? 'success' : 'light');
    } catch (err) {
      haptic('error');
      setFactCheckError(err instanceof Error ? err.message : 'Фактчек-базы недоступны');
    } finally {
      setFactCheckingId(null);
    }
  }
  const [sourceCheckError, setSourceCheckError] = useState<string | null>(null);

  async function handleCheckSource(segmentId: string) {
    if (!sourceCheckUrl.trim()) return;
    setCheckingSource(true);
    setSourceCheckError(null);
    try {
      const result = await checkAgainstUserSource(conversation.id, segmentId, sourceCheckUrl.trim());
      setSourceCheckResults((prev) => ({ ...prev, [segmentId]: result }));
      if (result.signal) {
        const list = await listDiscrepancies(conversation.id);
        setDiscrepancies(list);
      }
      setSourceCheckOpenFor(null);
      setSourceCheckUrl('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setSourceCheckError(err instanceof Error ? err.message : 'Не удалось проверить по ссылке');
    } finally {
      setCheckingSource(false);
    }
  }

  // Пункт 41: выгрузка пронумерованного списка утверждений для ручной
  // проверки — не автономный поиск, только форматирование уже
  // известных приложению данных, которые пользователь уносит куда
  // угодно (см. discrepancy-analysis.service.ts).
  const [exportedFacts, setExportedFacts] = useState<FactsToVerifyExport | null>(null);
  const [exportingFacts, setExportingFacts] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExportFacts() {
    setExportingFacts(true);
    setExportError(null);
    try {
      const result = await exportFactsToVerify(conversation.id);
      setExportedFacts(result);
      haptic('success');
    } catch (err) {
      haptic('error');
      setExportError(err instanceof Error ? err.message : 'Не удалось выгрузить список');
    } finally {
      setExportingFacts(false);
    }
  }

  // Пункт 18: Do Not Say (§3.53 ТЗ) — та же механика, что поворотные
  // точки, но отдельная кнопка (два разных AI-вызова, пользователь
  // может захотеть только один из них) и метки только на репликах
  // самого пользователя (isSelf) — сервер уже фильтрует это на
  // detect(), но UI-метка тоже привязана только к тем сегментам, где
  // реально пришёл ответ (сегменты собеседника просто не попадут в
  // doNotSayBySegment).
  const [doNotSayItems, setDoNotSayItems] = useState<DoNotSayItem[]>([]);
  const [detectingDoNotSay, setDetectingDoNotSay] = useState(false);
  const [doNotSayError, setDoNotSayError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (conversation.status !== 'TRANSCRIBED' && conversation.status !== 'ANALYZED') return;
    listDoNotSay(conversation.id)
      .then(setDoNotSayItems)
      .catch(() => setDoNotSayItems([]));
  }, [expanded, conversation.id, conversation.status]);

  async function handleDetectDoNotSay() {
    setDetectingDoNotSay(true);
    setDoNotSayError(null);
    try {
      await detectDoNotSay(conversation.id);
      const items = await listDoNotSay(conversation.id);
      setDoNotSayItems(items);
      haptic('success');
    } catch (err) {
      haptic('error');
      setDoNotSayError(
        err instanceof Error ? err.message : 'Не удалось проверить информационную гигиену',
      );
    } finally {
      setDetectingDoNotSay(false);
    }
  }

  const doNotSayBySegment = new Map<string | null, DoNotSayItem>(
    doNotSayItems.map((item): [string | null, DoNotSayItem] => [item.transcriptSegmentId, item]),
  );

  // Пункт 19: Best Next Move (§3.54 ТЗ) — не по-репличная фича, в
  // отличие от поворотных точек/Do Not Say: одна рекомендация на весь
  // разговор целиком, поэтому не мапится на конкретный сегмент —
  // рендерится отдельным блоком после транскрипта, не бейджем внутри
  // списка реплик.
  const [bestNextMove, setBestNextMove] = useState<BestNextMoveRecommendation | null>(null);
  const [detectingBestNextMove, setDetectingBestNextMove] = useState(false);
  const [bestNextMoveError, setBestNextMoveError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (conversation.status !== 'TRANSCRIBED' && conversation.status !== 'ANALYZED') return;
    getLatestBestNextMove(conversation.id)
      .then(setBestNextMove)
      .catch(() => setBestNextMove(null));
  }, [expanded, conversation.id, conversation.status]);

  async function handleDetectBestNextMove() {
    setDetectingBestNextMove(true);
    setBestNextMoveError(null);
    try {
      const rec = await detectBestNextMove(conversation.id);
      setBestNextMove(rec);
      haptic('success');
    } catch (err) {
      haptic('error');
      setBestNextMoveError(
        err instanceof Error ? err.message : 'Не удалось сформировать рекомендацию',
      );
    } finally {
      setDetectingBestNextMove(false);
    }
  }

  return (
    <li className="conversations-list__item">
      <div className="conversations-list__row" onClick={() => setExpanded((v) => !v)}>
        <span>{new Date(conversation.occurredAt).toLocaleString()}</span>
        <span className={`conversation-status conversation-status--${conversation.status.toLowerCase()}`}>
          {STATUS_LABELS[conversation.status] ?? conversation.status}
        </span>
      </div>

      {expanded && detail && (
        <div className="conversation-detail">
          {detail.transcript ? (
            detail.transcript.segments.length === 0 ? (
              <p className="conversations-section__hint">Реплики не распознаны.</p>
            ) : (
              <>
                {/* Пункт 26: сопоставление диаризации — по одному
                 * выпадающему списку на каждого УНИКАЛЬНОГО участника
                 * (не на каждую реплику), список формируется через Set
                 * по participantId, чтобы не дублировать элемент
                 * управления построчно. */}
                {detail.participants.length > 0 && (
                  <div className="participant-assignment">
                    <p className="steelman-case__label">Кто есть кто в записи</p>
                    {detail.participants.map((p) => (
                      <label key={p.id} className="participant-assignment__row">
                        <span>{p.person?.displayName ?? p.diarizationLabel}</span>
                        <select
                          value={p.isSelf ? '__self__' : (p.personId ?? '')}
                          onChange={(e) => handleAssignParticipant(p.id, e.target.value)}
                        >
                          <option value="">Не сопоставлено</option>
                          <option value="__self__">Это я</option>
                          {people.map((link) => (
                            <option key={link.personId} value={link.personId}>
                              {link.person.displayName ?? 'Без имени'}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}

                <ul className="transcript-segments">
                  {detail.transcript.segments.map((seg) => {
                    const participant = detail.participants.find((p) => p.id === seg.participantId);
                    const turningPoint = turningPointsBySegment.get(seg.id);
                    const doNotSayItem = doNotSayBySegment.get(seg.id);
                    const manipulationPoint = manipulationBySegment.get(seg.id);
                    const discrepancy = discrepancyBySegment.get(seg.id);
                    return (
                      <li key={seg.id} className="transcript-segments__item">
                        <span className="transcript-segments__speaker">
                          {participant?.person?.displayName ?? participant?.diarizationLabel ?? 'Спикер'}
                        </span>
                        <span>{seg.text}</span>
                        {discrepancy && (
                          <div className={`discrepancy discrepancy--${discrepancy.severity?.toLowerCase()}`}>
                            <span className="discrepancy__badge">
                              {discrepancy.severity === 'STRONG_DISCREPANCY' && '💩 Сильное расхождение'}
                              {discrepancy.severity === 'DISCREPANCY' && '🔴 Противоречие'}
                              {discrepancy.severity === 'INACCURACY' && '🟠 Неточность'}
                            </span>
                            {discrepancy.sourceDescription && (
                              <span className="discrepancy__source">Утверждение расходится с источником: {discrepancy.sourceDescription}</span>
                            )}
                            {discrepancy.severity !== 'INACCURACY' && !discrepancy.userConfirmedIntentionalFalsehood && (
                              <button type="button" onClick={() => handleConfirmIntentional(discrepancy.id)}>
                                Отметить как заведомую ложь
                              </button>
                            )}
                            {discrepancy.userConfirmedIntentionalFalsehood && (
                              <span className="discrepancy__confirmed">Отмечено пользователем как заведомая ложь</span>
                            )}
                          </div>
                        )}
                        {sourceCheckResults[seg.id] && (
                          <div className={`source-check-result source-check-result--${sourceCheckResults[seg.id].outcome.toLowerCase()}`}>
                            <span className="source-check-result__badge">
                              {sourceCheckResults[seg.id].outcome === 'CONFIRMED' && '✅ Источник подтверждает'}
                              {sourceCheckResults[seg.id].outcome === 'CONTRADICTED' && '❌ Источник противоречит'}
                              {sourceCheckResults[seg.id].outcome === 'INSUFFICIENT' && '❓ Источник не даёт ответа'}
                            </span>
                            <span>{sourceCheckResults[seg.id].explanation}</span>
                          </div>
                        )}
                        {sourceCheckOpenFor === seg.id ? (
                          <div className="conversations-section__add">
                            <label>
                              Ссылка на источник
                              <input
                                value={sourceCheckUrl}
                                onChange={(e) => setSourceCheckUrl(e.target.value)}
                                placeholder="https://…"
                              />
                            </label>
                            {sourceCheckError && <p className="generation-error">{sourceCheckError}</p>}
                            <div className="conversations-section__add-actions">
                              <button
                                type="button"
                                onClick={() => handleCheckSource(seg.id)}
                                disabled={checkingSource || !sourceCheckUrl.trim()}
                              >
                                {checkingSource ? 'Сверяем…' : 'Проверить'}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setSourceCheckOpenFor(null); setSourceCheckUrl(''); setSourceCheckError(null); }}
                                disabled={checkingSource}
                              >
                                Отмена
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="conversations-section__add-actions">
                            <button type="button" onClick={() => setSourceCheckOpenFor(seg.id)}>
                              Проверить по ссылке
                            </button>
                            <button type="button" onClick={() => handleFactCheck(seg.id, seg.text)} disabled={factCheckingId === seg.id}>
                              {factCheckingId === seg.id ? 'Ищем…' : 'Сверить с фактчек-базами'}
                            </button>
                          </div>
                        )}
                        {factCheckError && <p className="generation-error">{factCheckError}</p>}
                        {factCheckResults[seg.id] && (
                          <div className="source-check-result">
                            {factCheckResults[seg.id].claims.length === 0 ? (
                              <span>❓ В публичных фактчек-базах (Google Fact Check Tools) похожих утверждений не найдено — это не значит «правда», только «никто не проверял».</span>
                            ) : (
                              <>
                                <span className="source-check-result__badge">{factCheckResults[seg.id].signal ? '❌ Есть опровержение' : '🔎 Найдено в фактчек-базах'}</span>
                                <ul className="dtp-access-log">
                                  {factCheckResults[seg.id].claims.slice(0, 3).map((c) => (
                                    <li key={c.claimId}>
                                      <strong>{c.publisher}:</strong> «{c.textualRating}»
                                      {c.title && <> — <a href={c.reviewUrl} target="_blank" rel="noreferrer">{c.title}</a></>}
                                      {!c.title && <> — <a href={c.reviewUrl} target="_blank" rel="noreferrer">разбор</a></>}
                                      {c.reviewDate && <span className="dtp-muted"> · {c.reviewDate}</span>}
                                      {c.claimant && <span className="dtp-muted"> · утверждал: {c.claimant}</span>}
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </div>
                        )}
                        {manipulationPoint && (
                          <div className="manipulation-point">
                            <span className="manipulation-point__badge">
                              🚩 {manipulationPoint.technique ?? 'Манипулятивный приём'}
                            </span>
                            {manipulationPoint.description && (
                              <span className="manipulation-point__description">{manipulationPoint.description}</span>
                            )}
                          </div>
                        )}
                        {turningPoint && (
                          <div className="turning-point">
                            <span className="turning-point__badge">
                              {turningPoint.signalType === 'EMOTIONAL_SHIFT' ? '⚡ Перелом накала' : '🟢 Сдвиг позиции'}
                              {turningPoint.signalType === 'ARGUMENT_ACCEPTANCE' &&
                                turningPoint.confirmedGenuinely === false &&
                                ' (похоже на манипуляцию, не искреннее)'}
                            </span>
                            {turningPoint.description && (
                              <span className="turning-point__description">{turningPoint.description}</span>
                            )}
                          </div>
                        )}
                        {doNotSayItem && (
                          <div className="do-not-say-warning">
                            <span className="do-not-say-warning__badge">
                              {doNotSayItem.riskCategory === 'ESCALATION'
                                ? '⚠️ Может обострить конфликт'
                                : '⚠️ Может быть использовано против вас'}
                            </span>
                            {doNotSayItem.why && (
                              <span className="do-not-say-warning__why">{doNotSayItem.why}</span>
                            )}
                            {doNotSayItem.saferAlternative && (
                              <span className="do-not-say-warning__alternative">
                                Лучше сказать: «{doNotSayItem.saferAlternative}»
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {conversation.status === 'TRANSCRIBED' && (
                  <button type="button" onClick={handleDetect} disabled={detecting}>
                    {detecting ? 'Ищем переломные моменты…' : 'Найти поворотные точки'}
                  </button>
                )}
                {conversation.status === 'ANALYZED' && turningPoints.length === 0 && (
                  <p className="conversations-section__hint">Явных поворотных точек не найдено.</p>
                )}
                {detectError && <p className="generation-error">{detectError}</p>}

                {(conversation.status === 'TRANSCRIBED' || conversation.status === 'ANALYZED') && (
                  <button type="button" onClick={handleDetectDoNotSay} disabled={detectingDoNotSay}>
                    {detectingDoNotSay ? 'Проверяем реплики…' : 'Проверить, что не стоило говорить'}
                  </button>
                )}
                {doNotSayError && <p className="generation-error">{doNotSayError}</p>}

                {(conversation.status === 'TRANSCRIBED' || conversation.status === 'ANALYZED') && (
                  <button type="button" onClick={handleDetectManipulation} disabled={detectingManipulation}>
                    {detectingManipulation ? 'Проверяем на манипуляции…' : 'Найти манипулятивные приёмы'}
                  </button>
                )}
                {manipulationError && <p className="generation-error">{manipulationError}</p>}

                {(conversation.status === 'TRANSCRIBED' || conversation.status === 'ANALYZED') && (
                  <button type="button" onClick={handleDetectDiscrepancies} disabled={detectingDiscrepancies}>
                    {detectingDiscrepancies ? 'Сверяем с источниками…' : 'Проверить на расхождения'}
                  </button>
                )}
                {discrepancyError && <p className="generation-error">{discrepancyError}</p>}

                {discrepancies.length > 0 && (
                  <button type="button" onClick={handleExportFacts} disabled={exportingFacts}>
                    {exportingFacts ? 'Формируем список…' : 'Выгрузить список для проверки'}
                  </button>
                )}
                {exportError && <p className="generation-error">{exportError}</p>}
                {exportedFacts && (
                  <div className="facts-export">
                    <p className="conversations-section__hint">
                      Скопируйте текст ниже и проверьте самостоятельно — приложение ничего не искало само.
                    </p>
                    <textarea readOnly value={exportedFacts.text} className="facts-export__textarea" />
                  </div>
                )}

                {(conversation.status === 'TRANSCRIBED' || conversation.status === 'ANALYZED') && (
                  <button type="button" onClick={handleDetectBestNextMove} disabled={detectingBestNextMove}>
                    {detectingBestNextMove ? 'Формируем рекомендацию…' : 'Рекомендовать следующий шаг'}
                  </button>
                )}
                {bestNextMoveError && <p className="generation-error">{bestNextMoveError}</p>}
                {bestNextMove && (
                  <div className="best-next-move">
                    <div className="best-next-move__item">
                      <span className="best-next-move__label">Лучшее следующее действие</span>
                      <span>{bestNextMove.bestAction}</span>
                      <SpeakButton text={bestNextMove.bestAction} />
                    </div>
                    <div className="best-next-move__item">
                      <span className="best-next-move__label">Альтернатива</span>
                      <span>{bestNextMove.alternative}</span>
                    </div>
                    {bestNextMove.whyNotAlternative && (
                      <div className="best-next-move__item best-next-move__item--secondary">
                        <span className="best-next-move__label">Почему не альтернатива</span>
                        <span>{bestNextMove.whyNotAlternative}</span>
                      </div>
                    )}
                    <div className="best-next-move__item best-next-move__item--avoid">
                      <span className="best-next-move__label">Чего избегать</span>
                      <span>{bestNextMove.avoid}</span>
                    </div>
                    <div className="best-next-move__item">
                      <span className="best-next-move__label">Почему</span>
                      <span>{bestNextMove.why}</span>
                    </div>
                    {bestNextMove.whatCouldChange && (
                      <div className="best-next-move__item best-next-move__item--secondary">
                        <span className="best-next-move__label">Что могло бы изменить рекомендацию</span>
                        <span>{bestNextMove.whatCouldChange}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          ) : conversation.status === 'FAILED' ? (
            <p className="generation-error">Расшифровка не удалась.</p>
          ) : (
            <p className="conversations-section__hint">Расшифровка ещё не готова.</p>
          )}
        </div>
      )}
    </li>
  );
}
