'use client';

// Пункт [job-domain-v2] — инструменты соискателя поверх листа VACANCY_RESPONSE:
// CV-вариант под вакансию (К-21…К-28: карта подсветки → компиляция →
// переформулировка с подтверждением → перевод с обратной сверкой), диалог по
// непокрытым пунктам (К-21), самошеринг (К-8), сценарии оплаты по своим
// границам (К-4), репетиция по листу (К-2), тестовое задание (К-9), прогноз
// (К-10), письмо-отклик и пакет (К-14/К-19). Везде: «CV — только из ваших
// слов», «правильных ответов нет», «рыночной зарплаты здесь нет».
import { useEffect, useState } from 'react';
import { Sheet, intakeApi, selfShareApi, sheetsApi } from '../../../lib/hiring/api';
import { domainApi } from '../../../lib/domains/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { DraftSkipsNotes, IntakeNotes } from '../../SkippedNotes';
import { splitLines } from '../../../lib/form-input';
import { ShareLinkView } from '../InterviewPoolWorkspace';
import { VoiceTextInput } from '../VoiceTextInput';
import { haptic } from '../../../lib/telegram';
import { TranslationCheckNote } from '../../TranslationCheckNote';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); after?.(r); return r; } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  }
  return { busy, error, setError, run };
}

function CvVariantTool({ sheet, projectId, refresh }: { sheet: Sheet; projectId: string; refresh: () => void }) {
  const { busy, error, setError, run } = useAction();
  const [map, setMap] = useState<any[] | null>(null);
  const [variant, setVariant] = useState<any | null>(null);
  const [diffs, setDiffs] = useState<any | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [letter, setLetter] = useState<any | null>(null);
  const employerClause = (id: string) => sheet.clauses.find((c) => c.id === id)?.text ?? id;

  return (
    <div className="dtp-section">
      <h3>Резюме под эту вакансию</h3>
      <p className="dtp-hint">Вариант собирается только из вашего базового резюме: приложение переставляет и подсвечивает ваши же факты под пункты вакансии, ничего не добавляя. Формулировки меняются лишь с вашего подтверждения.</p>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {sheet.cvVariants.length > 0 && (
        <ul>
          {sheet.cvVariants.map((v) => (
            <li key={v.id}>
              <button type="button" className="dtp-link" onClick={() => run(() => domainApi.getJson(`/cv-variants/${v.id}`), setVariant)}>
                {v.lang.toUpperCase()} · {new Date(v.compiledAt).toLocaleString('ru-RU')} · {v.reviewedAt ? 'утверждён' : 'черновик'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="entity-form__actions">
        <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.cvPropose(sheet.id), (m) => { setMap(m); setSelected({}); })}>Предложить карту подсветки (AI)</button>
        {map && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.cvCompile(sheet.id, map), (v) => { setVariant(v); refresh(); })}>Собрать вариант</button>}
      </div>
      {map && (
        <>
          <h4>Карта: фрагмент резюме → пункт вакансии</h4>
          {map.length === 0 && <p className="card-section__empty">AI не нашёл, какие фрагменты вашего резюме отвечают пунктам вакансии.</p>}
          <ul>
            {map.map((e: any) => (
              <li key={`${e.highlightRef}-${e.clauseId}`}>
                <label><input type="checkbox" checked={!!selected[e.highlightRef]} onChange={(ev) => setSelected({ ...selected, [e.highlightRef]: ev.target.checked })} /> <code>{e.highlightRef}</code> → {employerClause(e.clauseId)}</label>
                {e.rephrased && <div className="dtp-muted">переформулировка: «{e.rephrased}» {e.rephraseConfirmed ? '(подтверждена)' : '(не подтверждена — в текст не пойдёт)'}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {variant && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>Вариант {String(variant.lang ?? 'ru').toUpperCase()}</span><span className="domain-badge">{variant.reviewedAt ? 'утверждён' : 'черновик'}</span></div>
          <div className="dtp-card__body">
            {variant.cvText && <pre className="script-text">{variant.cvText}</pre>}
            {/* Пункт [translated-adds] 2026-09-06: здесь стояла одна
                строка «Потеряно: … · Добавлено: …», целиком из
                самоотчёта модели и без различения проверки и мнения. */}
            <TranslationCheckNote backCheck={variant.backCheck} unverifiable={(variant as any).backCheckUnverifiable} />
            <div className="entity-form__actions">
              {!variant.reviewedAt && <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.cvReview(variant.id), (v) => { setVariant(v); refresh(); })}>Утвердить</button>}
              <button type="button" className="secondary" disabled={busy || !Object.values(selected).some(Boolean)} onClick={() => run(() => sheetsApi.cvRephrase(variant.id, Object.keys(selected).filter((k) => selected[k])), setDiffs)}>Переформулировать отмеченные (AI)</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.cvTranslate(variant.id, variant.lang === 'en' ? 'ru' : 'en'), (v) => { setVariant(v); refresh(); })}>Перевести на {variant.lang === 'en' ? 'русский' : 'английский'}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => intakeApi.coverLetter(projectId, sheet.id, { notCoveredHandling: 'name_honestly', cvVariantId: variant.id }), setLetter)}>Письмо-отклик</button>
            </div>
            {diffs && (
              <>
                <h4>Было → стало (подтвердите, что смысл ваш)</h4>
                <ul>{(diffs.diffs ?? []).map((d: any) => <li key={d.highlightRef}><code>{d.highlightRef}</code>: «{d.before}» → «{d.after}»</li>)}</ul>
                <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.cvRephraseConfirm(variant.id, (diffs.diffs ?? []).map((d: any) => d.highlightRef)), () => setDiffs(null))}>Подтвердить формулировки</button>
              </>
            )}
            {letter && (
              <>
                <h4>Письмо-отклик</h4>
                <p className="dtp-muted">Только из вашего резюме; пункты, которых у вас нет, названы честно — не приукрашены.</p>
                <pre className="script-text">{letter.text ?? JSON.stringify(letter, null, 2)}</pre>
                {letter.notCovered?.length > 0 && <p className="dtp-muted">Не отражено: {letter.notCovered.join('; ')}</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DialogueTool({ sheet, refresh }: { sheet: Sheet; refresh: () => void }) {
  const { busy, error, setError, run } = useAction();
  const [q, setQ] = useState<any | null | undefined>(undefined);
  const [answer, setAnswer] = useState('');
  useEffect(() => { sheetsApi.dialogueNext(sheet.id).then(setQ).catch(setError); }, [sheet.id, setError]);
  return (
    <div className="dtp-section">
      <h3>Уточнить непокрытые пункты</h3>
      <p className="dtp-hint">Приложение задаёт вопрос по пункту вакансии, которого нет в вашем резюме; ваш ответ становится источником — и только он. Формулировок «за вас» здесь нет.</p>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {q === undefined && <p className="dtp-muted">Ищем открытый пункт…</p>}
      {q === null && <p className="card-section__empty">Все пункты вакансии либо отражены, либо уже уточнены (до 3 вопросов на пункт).</p>}
      {q && (
        <>
          <p><strong>{q.clauseText}</strong> <span className="dtp-muted">· попытка {q.attempt} из {q.maxAttempts}</span></p>
          <p>{q.question}</p>
          <VoiceTextInput value={answer} onChange={setAnswer} placeholder="Ответьте своими словами — голосом или текстом" />
          <div className="entity-form__actions">
            <button type="button" className="primary" disabled={busy || !answer.trim()} onClick={() => run(() => sheetsApi.dialogueAnswer(sheet.id, { clauseId: q.clauseId, text: answer }), () => { setAnswer(''); refresh(); sheetsApi.dialogueNext(sheet.id).then(setQ).catch(setError); })}>Ответить</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => sheetsApi.dialogueNext(sheet.id).then(setQ).catch(setError)}>Другой пункт</button>
          </div>
        </>
      )}
    </div>
  );
}

function SelfShareTool({ sheet }: { sheet: Sheet }) {
  const { busy, error, setError, run } = useAction();
  const [consent, setConsent] = useState<any | null>(null);
  const [shares, setShares] = useState<any[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [edge, setEdge] = useState<'to_agency' | 'to_employer'>('to_employer');
  const [variantId, setVariantId] = useState<string>(sheet.cvVariants.find((v) => v.reviewedAt)?.id ?? '');
  const reload = () => { void selfShareApi.list(sheet.id).then(setShares).catch(setError); };
  useEffect(() => { selfShareApi.consentText().then(setConsent).catch(setError); reload(); }, [sheet.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = sheet.clauses.filter((c) => c.side === 'CANDIDATE' && c.confirmedAt && !c.rejectedAt);
  const reviewed = sheet.cvVariants.filter((v) => v.reviewedAt);
  return (
    <div className="dtp-section">
      <h3>Передать своё резюме</h3>
      <p className="dtp-hint">Уходит только утверждённый вариант резюме и отмеченные вами пункты — ни базовое резюме, ни границы переговоров, ни заметки. Согласие — это сам акт передачи; отозвать можно в любой момент.</p>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {link && <ShareLinkView link={link.link} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      {reviewed.length === 0 ? <p className="card-section__empty">Сначала соберите и утвердите вариант резюме под эту вакансию.</p> : (
        <>
          <label>Вариант резюме<br />
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              <option value="">— выберите —</option>
              {reviewed.map((v) => <option key={v.id} value={v.id}>{v.lang.toUpperCase()} · {new Date(v.compiledAt).toLocaleDateString('ru-RU')}</option>)}
            </select>
          </label>
          <label>Кому<br />
            <select value={edge} onChange={(e) => setEdge(e.target.value as any)}>
              <option value="to_employer">работодателю напрямую</option>
              <option value="to_agency">агентству</option>
            </select>
          </label>
          {mine.length > 0 && (
            <>
              <h4>Какие мои пункты показать</h4>
              <ul>{mine.map((c) => <li key={c.id}><label><input type="checkbox" checked={!!visible[c.id]} onChange={(e) => setVisible({ ...visible, [c.id]: e.target.checked })} /> {c.text}</label></li>)}</ul>
            </>
          )}
          {consent && (
            <div className="consent-gate">
              <p className="dtp-muted">Текст согласия, версия {consent.version}:</p>
              <pre className="script-text">{consent.text}</pre>
              <label><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> Согласен(на) на передачу на этих условиях</label>
            </div>
          )}
          <button type="button" className="primary" disabled={busy || !agreed || !variantId} onClick={() => run(() => selfShareApi.create(sheet.id, { cvVariantId: variantId, visibleClauseIds: Object.keys(visible).filter((k) => visible[k]), edge, consentVersion: consent?.version ?? null }), (r) => { setLink({ link: r.deepLink, expiresAt: r.expiresAt }); reload(); })}>Создать ссылку для передачи</button>
        </>
      )}
      {shares && shares.length > 0 && (
        <>
          <h4>Мои передачи</h4>
          <ul>
            {shares.map((s: any) => (
              <li key={s.id}>
                {s.edge === 'to_agency' || s.acceptedIntoMode === 'INTERVIEW_POOL' ? 'агентству' : 'работодателю'} · {new Date(s.createdAt).toLocaleDateString('ru-RU')} · {s.revokedAt ? 'отозвано' : s.acceptedAt ? 'принято' : 'ожидает'}
                {!s.revokedAt && <> · <button type="button" className="dtp-link" disabled={busy} onClick={() => run(() => selfShareApi.revoke(s.id), reload)}>отозвать согласие</button></>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** К-6 (аудит 2026-09-03: маршрут и клиент были, экрана не было) —
 * подсказка соискателю по СВОЕМУ листу во время разговора: какой пункт ещё
 * не обсуждён. Никаких оценок собеседника: подсказка только про ваши
 * незакрытые пункты, и один пункт подсказывается один раз. */
function LiveHintTool({ sheet }: { sheet: Sheet }) {
  const { busy, error, setError, run } = useAction();
  const [window_, setWindow] = useState('');
  const [hint, setHint] = useState<{ hintText: string; clauseId: string | null } | null | undefined>(undefined);
  const clauseText = (id: string | null) => sheet.clauses.find((c) => c.id === id)?.text ?? null;
  return (
    <div className="dtp-section">
      <h4>Подсказка во время разговора</h4>
      <p className="dtp-hint">Вставьте последние реплики собеседования — приложение напомнит про пункт вашего листа, который ещё не обсуждался. Это подсказка вам о ваших условиях, а не разбор собеседника: оценок человека напротив здесь нет.</p>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <VoiceTextInput value={window_} onChange={setWindow} placeholder="…последние реплики разговора" />
      <button type="button" className="secondary" disabled={busy || !window_.trim()} onClick={() => run(() => sheetsApi.liveHint(sheet.id, window_), (h) => setHint(h as any))}>
        {busy ? '…' : 'Что я ещё не спросил(а)'}
      </button>
      {hint === null && <p className="card-section__empty">Уместного момента нет — либо все пункты уже обсуждены, либо по этому фрагменту напоминать не о чем.</p>}
      {hint && (
        <p className="dtp-status dtp-status--warn">
          {hint.hintText}
          {clauseText(hint.clauseId) && <span className="dtp-muted"> · пункт: {clauseText(hint.clauseId)}</span>}
        </p>
      )}
    </div>
  );
}

function ExtrasTool({ sheet, projectId }: { sheet: Sheet; projectId: string }) {
  const { busy, error, setError, run } = useAction();
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [mode, setMode] = useState<'none' | 'test' | 'prediction' | 'rehearsal' | 'package'>('none');
  const [sessions, setSessions] = useState<any[] | null>(null);
  const show = (title: string) => (data: any) => setOut({ title, data });
  return (
    <div className="dtp-section">
      <h3>Подготовка и переговоры</h3>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <div className="entity-form__actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.salaryScenarios(sheet.id), show('Сценарии по вашим границам'))}>Оплата: принять / встречное / отказ</button>
        <button type="button" className="secondary" disabled={busy} onClick={async () => { setMode('rehearsal'); try { setSessions(await domainApi.getJson(`/projects/${projectId}/sparring-sessions`)); } catch (e) { setError(e); } }}>Позиции из репетиции</button>
        <button type="button" className="secondary" onClick={() => setMode('test')}>Тестовое задание по пунктам</button>
        <button type="button" className="secondary" onClick={() => setMode('prediction')}>Мой прогноз по процессу</button>
        <button type="button" className="secondary" onClick={() => setMode('package')}>Пакет отклика</button>
      </div>
      <p className="dtp-hint">Сценарии оплаты строятся из ваших границ переговоров (идеал / приемлемо / BATNA / точка отказа) — не из «рынка», которого у приложения нет. Позиции из репетиции — только из ваших реплик; тестовое задание сверяется «отражено / не отражено», а не «правильно / неправильно».</p>
      {mode === 'rehearsal' && (
        <div>
          {!sessions && <p className="dtp-muted">Загрузка репетиций…</p>}
          {sessions && sessions.length === 0 && <p className="card-section__empty">Репетиций (спарринга) в проекте пока нет — проведите её на вкладке проекта.</p>}
          <ul>{(sessions ?? []).map((s: any) => <li key={s.id}><button type="button" className="dtp-link" disabled={busy} onClick={() => run(() => sheetsApi.rehearsalPositions(sheet.id, s.id), show('Позиции из репетиции'))}>{s.scenario ?? s.title ?? s.id} · {s.createdAt ? new Date(s.createdAt).toLocaleString('ru-RU') : ''}</button></li>)}</ul>
          <button type="button" className="secondary" onClick={() => setMode('none')}>Закрыть</button>
        </div>
      )}
      {mode === 'test' && (
        <EntityForm
          fields={[{ name: 'assignmentText', label: 'Текст задания', type: 'textarea', required: true }, { name: 'answerText', label: 'Ваш ответ / решение', type: 'textarea', required: true }]}
          submitLabel="Сверить по пунктам" onCancel={() => setMode('none')}
          onSubmit={async (v) => { show('Тестовое задание: что отражено в ответе')(await sheetsApi.testAssignment(sheet.id, v as any)); setMode('none'); }}
        />
      )}
      {mode === 'prediction' && (
        <EntityForm
          fields={[{ name: 'predictedOutcome', label: 'Чего вы ожидаете от этого процесса', type: 'textarea', required: true, hint: 'Позже отметите, что вышло на самом деле — в «Прогнозах» проекта' }]}
          submitLabel="Записать" onCancel={() => setMode('none')}
          onSubmit={async (v) => { await sheetsApi.prediction(sheet.id, String(v.predictedOutcome)); setMode('none'); haptic('success'); }}
        />
      )}
      {mode === 'package' && (
        <EntityForm
          fields={[
            { name: 'notCoveredHandling', label: 'Пункты, которых у меня нет', type: 'select', required: true, options: [{ value: 'name_honestly', label: 'назвать честно' }, { value: 'skip', label: 'не упоминать' }] },
            /* Пункт [own-input] 2026-09-04: потолок назван ЗАРАНЕЕ, до
               отправки. Раньше экран резал список до восьми молча — и
               сервер резал ещё раз, — так что человек вписывал
               двенадцать вопросов и не узнавал, что четыре не ушли. */
            { name: 'questions', label: 'Вопросы работодателю (по одному в строке)', type: 'textarea', hint: 'В пакет попадут первые восемь — остальные лучше задать отдельно' },
          ]}
          initial={{ notCoveredHandling: 'name_honestly' }}
          submitLabel="Собрать пакет" onCancel={() => setMode('none')}
          /* Обрезка убрана с экрана целиком: резать в двух местах — способ
             однажды получить два разных потолка. Режет сервер, он же
             сообщает, сколько не поместилось. */
          onSubmit={async (v) => { show('Пакет отклика')(await intakeApi.applicationPackage(projectId, sheet.id, { notCoveredHandling: v.notCoveredHandling as any, questions: splitLines(String(v.questions ?? '')) })); setMode('none'); }}
        />
      )}
      {out && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div>
          <div className="dtp-card__body">
            {out.data?.frame && <p className="dtp-status dtp-status--warn">{out.data.frame}</p>}
            {/* [draft-outcome] 2026-09-04: разбор оффера и диалог о CV —
                места, где человек решает по списку, что ему предложили и
                что из его слов зачлось. Не разобранное названо. */}
            <IntakeNotes intake={out.data?.intake} storedIntake={out.data?.storedIntake} what="текст источника" />
            <DraftSkipsNotes skips={out.data?.draftSkips} />
            {Array.isArray(out.data?.scenarios) ? out.data.scenarios.map((s: any) => (
              <div key={s.kind}><h4>{s.kind === 'accept' ? 'Принять' : s.kind === 'counter' ? 'Встречное предложение' : 'Отказаться'}</h4><p>{s.consequences}</p>{s.script && <pre className="script-text">{s.script}</pre>}</div>
            )) : <JsonView data={Object.fromEntries(Object.entries(out.data ?? {}).filter(([k]) => k !== 'frame'))} />}
          </div>
        </div>
      )}
    </div>
  );
}

export function CandidateSheetTools({ sheet, projectId, refresh }: { sheet: Sheet; projectId: string; refresh: () => void }) {
  const [sub, setSub] = useState<'cv' | 'dialogue' | 'share' | 'extras'>('cv');
  return (
    <>
      <nav className="domain-tabs">
        {([['cv', 'Резюме под вакансию'], ['dialogue', 'Уточнить пункты'], ['share', 'Передать'], ['extras', 'Подготовка']] as Array<[typeof sub, string]>).map(([k, l]) => (
          <button key={k} type="button" className={sub === k ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setSub(k)}>{l}</button>
        ))}
      </nav>
      {sub === 'cv' && <CvVariantTool sheet={sheet} projectId={projectId} refresh={refresh} />}
      {sub === 'dialogue' && <DialogueTool sheet={sheet} refresh={refresh} />}
      {sub === 'share' && <SelfShareTool sheet={sheet} />}
      {sub === 'extras' && (
        <>
          <ExtrasTool sheet={sheet} projectId={projectId} />
          <LiveHintTool sheet={sheet} />
        </>
      )}
    </>
  );
}
