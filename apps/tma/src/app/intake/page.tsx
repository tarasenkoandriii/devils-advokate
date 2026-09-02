'use client';

// ТЗ domain-ui-and-voice-intake §2.2 — экран квиза. Голос и текст
// равноправны (VoiceTextInput). AI предлагает — пользователь подтверждает;
// до подтверждения ничего не создаётся. Универсальный сценарий доступен
// одной кнопкой на любом шаге.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { intakeApi, IntakeScenario, IntakeSessionView } from '../../lib/intake';
import { DOMAIN_LIST, getManifest } from '../../lib/domains/manifests';
import { VoiceTextInput } from '../../components/domains/VoiceTextInput';
import { DomainConsentGate } from '../../components/domains/DomainConsentGate';
import { ConsentGate } from '../../components/ConsentGate';
import { hasConsent, listConsents } from '../../lib/features';
import { useBackButton } from '../../hooks/useBackButton';
import { haptic } from '../../lib/telegram';
import { currentStartAttribution } from '../../lib/start-param';

function scenarioTitle(s: IntakeScenario): string {
  if (s === 'UNIVERSAL') return 'Универсальный сценарий';
  const m = getManifest(s);
  return m ? `${m.icon} ${m.title}` : s;
}

/** Повторный аудит 2026-09-01: backend знает БОЛЬШЕ сценариев, чем в
 *  TMA собрано экранов (job-search — сценарий классификатора и полный
 *  модуль API, манифеста в приложении нет). Тип IntakeScenario этого не
 *  ловит: строка приходит с сервера в рантайме. Без проверки dispatch
 *  создавал реальный проект и уводил на /domains/job-search/<id>, где
 *  экран отвечает «Неизвестный сценарий.» — данные созданы, вернуться к
 *  ним из приложения нельзя. Проверка выводится из манифестов, поэтому
 *  следующий такой сценарий обработается сам. */
function isDispatchable(s: IntakeScenario | null): s is IntakeScenario {
  return s === 'UNIVERSAL' || (s !== null && getManifest(s) != null);
}

/** Метка источника для первой сессии квиза (§4 ТЗ job-landing).
 *
 *  ТОЛЬКО для посадочных. Ревью 2026-09-02: без этого условия в
 *  intake_sessions.source уезжал бы токен приглашения
 *  (`share_<секрет>`) — действующий секрет в аналитической колонке и в
 *  отчётном SQL. Атрибуция осмысленна лишь там, где источник известен. */
function startAttribution(): { source?: string; campaign?: string } | undefined {
  const parsed = currentStartAttribution();
  if (!parsed || !parsed.audience) return undefined;
  return { source: parsed.source, ...(parsed.campaign ? { campaign: parsed.campaign } : {}) };
}

export default function IntakePage() {
  const router = useRouter();
  const [aiConsent, setAiConsent] = useState<'loading' | 'needed' | 'ok'>('loading');
  const [session, setSession] = useState<IntakeSessionView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<IntakeScenario | null>(null);
  const [contractType, setContractType] = useState<'PRENUP' | 'DIVORCE_SETTLEMENT' | ''>('');
  useBackButton(() => router.push('/domains'));

  useEffect(() => {
    listConsents().then((c) => setAiConsent(hasConsent(c, 'EXTERNAL_AI') ? 'ok' : 'needed')).catch(() => setAiConsent('needed'));
  }, []);

  async function submit() {
    if (!draft.trim()) return;
    setBusy(true); setError(null);
    try {
      const next = session
        ? await intakeApi.answer(session.id, draft.trim())
        : await intakeApi.start(draft.trim(), startAttribution());
      setSession(next); setDraft(''); haptic('light');
      if (next.decision) setChosen(next.decision.scenario);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить');
    } finally { setBusy(false); }
  }

  async function dispatch(scenario: IntakeScenario) {
    if (!session) return;
    if (scenario === 'family-law' && !contractType && !session.extracted?.contractType) { setError('Выберите тип: брачный договор или соглашение при разводе'); return; }
    setBusy(true); setError(null);
    try {
      const res = await intakeApi.dispatch(session.id, scenario, scenario === 'family-law' ? (contractType || session.extracted?.contractType || undefined) : undefined);
      haptic('success');
      // Пункт [onboarding-continuity] 2026-09-02: conversationId
      // ПРОКИДЫВАЕТСЯ дальше. Раньше он здесь терялся, экран домена
      // открывал новый пустой разговор, и ответы квиза оставались в
      // первом — «данные не придётся вводить повторно» не работало ни
      // разу. Сервер теперь тоже не плодит разговоры, но параметр
      // избавляет от лишнего запроса и делает связь явной.
      router.push(
        scenario === 'UNIVERSAL'
          ? `/projects/${res.projectId}`
          : `/domains/${scenario}/${res.projectId}${res.conversationId ? `?c=${res.conversationId}` : ''}`,
      );
    } catch (e) {
      haptic('error');
      setError(e instanceof Error ? e.message : 'Не удалось передать в сценарий');
      setBusy(false);
    }
  }

  // Универсальный сценарий — из любого состояния, даже без AI-оценки:
  // если сессии ещё нет, просто уходим в обычную форму с текстом.
  function goUniversalNow() {
    if (session) return dispatch('UNIVERSAL');
    router.push('/');
  }

  if (aiConsent === 'loading') return <main className="page"><p>Загрузка…</p></main>;
  if (aiConsent === 'needed') return <main className="page"><h1>🎤 Подбор сценария</h1><ConsentGate onGranted={() => setAiConsent('ok')} /></main>;

  const decision = session?.decision ?? null;
  const suggested: IntakeScenario | null = chosen ?? decision?.scenario ?? null;
  // Сценарий без экрана в TMA не становится целью перехода — см.
  // isDispatchable выше. Пользователю об этом говорится прямо, а не
  // «Неизвестный сценарий» после создания проекта.
  const target: IntakeScenario | null = isDispatchable(suggested) ? suggested : null;
  const unsupported = suggested !== null && !isDispatchable(suggested) ? suggested : null;
  const targetManifest = target && target !== 'UNIVERSAL' ? getManifest(target) : null;

  return (
    <main className="page">
      <h1>🎤 Подбор сценария</h1>
      {!session && <p className="card-section__empty">Расскажите, что происходит — своими словами, голосом или текстом. Мы подберём сценарий, а всё сказанное уйдёт в него без повторного ввода. Аудио не сохраняется — только текст.</p>}
      {error && <p className="generation-error">{error}</p>}

      {session && (
        <ol className="domain-onboarding__answers">
          {session.answers.map((a, i) => (
            <li key={i}>{a.question && <><small className="voice-text-input__hint">{a.question}</small><br /></>}{a.text}</li>
          ))}
        </ol>
      )}

      {(!session || session.nextQuestion) && (
        <>
          {session?.nextQuestion && <p><strong>{session.nextQuestion}</strong> <small className="voice-text-input__hint">(уточнений осталось: {session.followUpsLeft})</small></p>}
          <VoiceTextInput value={draft} onChange={setDraft} disabled={busy} placeholder={session ? 'Ваш ответ…' : 'Например: вчера в меня въехали на парковке, виновник уехал…'} />
          <div className="entity-form__actions">
            <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={submit}>{busy ? '…' : session ? 'Ответить' : 'Оценить ситуацию'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={goUniversalNow}>Сразу в универсальный</button>
          </div>
        </>
      )}

      {session && decision && !session.nextQuestion && (
        <section className="domain-onboarding__draft">
          <h3>Похоже на: {scenarioTitle(decision.suggestedScenario)}</h3>
          {decision.belowThreshold && <p className="card-section__empty">Уверенность невысокая ({Math.round(decision.confidence * 100)}%) — по умолчанию предлагаем универсальный сценарий, но выбор за вами.</p>}
          {!decision.belowThreshold && <p className="card-section__empty">Уверенность {Math.round(decision.confidence * 100)}%. Это предложение — подтвердите или выберите другой.</p>}
          {session.extracted && (
            <dl className="domain-dl">
              <div><dt>Ситуация</dt><dd>{session.extracted.question}</dd></div>
              {session.extracted.goal && <div><dt>Цель</dt><dd>{session.extracted.goal}</dd></div>}
              {session.extracted.facts.length > 0 && <div><dt>Факты</dt><dd>{session.extracted.facts.join('; ')}</dd></div>}
            </dl>
          )}

          {unsupported && (
            <p className="generation-error">
              Сценарий «{unsupported}» на сервере есть, но экран для него в приложении ещё не собран — перейти в него нельзя.
              Всё сказанное не потеряно: выберите универсальный сценарий или другой из списка.
            </p>
          )}
          <p>Перейти в: <strong>{target ? scenarioTitle(target) : '—'}</strong></p>
          {picking && (
            <div className="entity-form__actions">
              {(['UNIVERSAL', ...DOMAIN_LIST.map((m) => m.id)] as IntakeScenario[]).map((s) => (
                <button key={s} type="button" className={s === target ? 'primary' : 'secondary'} onClick={() => { setChosen(s); setPicking(false); }}>{scenarioTitle(s)}</button>
              ))}
            </div>
          )}
          {target === 'family-law' && (
            <label className="entity-form__field"><span>Тип</span>
              <select value={contractType || session.extracted?.contractType || ''} onChange={(e) => setContractType(e.target.value as any)}>
                <option value="">—</option><option value="PRENUP">Брачный договор</option><option value="DIVORCE_SETTLEMENT">Соглашение при разводе</option>
              </select>
            </label>
          )}

          {targetManifest?.requiredConsent ? (
            <DomainConsentGate consentType={targetManifest.requiredConsent}>
              <button type="button" className="primary" disabled={busy || !target} onClick={() => target && dispatch(target)}>Да, перейти</button>
            </DomainConsentGate>
          ) : (
            <button type="button" className="primary" disabled={busy || !target} onClick={() => target && dispatch(target)}>Да, перейти</button>
          )}
          <div className="entity-form__actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => setPicking(!picking)}>Выбрать другой</button>
            {target !== 'UNIVERSAL' && <button type="button" className="secondary" disabled={busy} onClick={() => dispatch('UNIVERSAL')}>Универсальный</button>}
          </div>
        </section>
      )}
      <p><Link href="/domains">← Все сценарии</Link></p>
    </main>
  );
}
