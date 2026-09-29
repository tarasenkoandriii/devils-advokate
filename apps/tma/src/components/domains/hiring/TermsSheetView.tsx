'use client';

// Пункт [job-domain-v2] §6.1 — лист условий как договорный документ: один
// экран для трёх видов (VACANCY / INTERVIEW / VACANCY_RESPONSE) и двух ролей.
// Что держит бэкенд и повторяет экран: пункт — черновик до подтверждения
// человеком; позиция — только с опорой (цитата), черновик до подтверждения;
// ни одного числа по человеку: покрытие требования — «отражено / частично /
// не отражено / не обсуждалось», условие — «предложено / принято / встречное /
// отклонено / открыто». Автоматический переход статуса — только DRAFT →
// IN_NEGOTIATION; остальное — человек руками.
import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
  Clause,
  Coverage,
  COVERAGE_LABEL,
  EVIDENCE_LABEL,
  Position,
  Sheet,
  SheetStatus,
  SIDE_LABEL,
  Stance,
  STANCE_LABEL,
  STATUS_LABEL,
  TermsSide,
  sheetsApi,
} from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { haptic } from '../../../lib/telegram';
import { DraftSkipsNotes, IntakeNotes } from '../../SkippedNotes';

export type SheetRole = 'candidate' | 'team';

export function useSheet(sheetId: string | null) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!sheetId) return;
    setError(null);
    sheetsApi.get(sheetId).then(setSheet).catch((e: unknown) => setError(e ?? new Error('Не удалось загрузить лист')));
  }, [sheetId, tick]);
  return { sheet, error, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

function PositionView({ p, who }: { p: Position; who: string }) {
  const label = p.coverage ? COVERAGE_LABEL[p.coverage] : p.stance ? STANCE_LABEL[p.stance] : '—';
  return (
    <div className="dtp-evidence">
      <span className="dtp-evidence__icon">{p.confirmedAt ? '●' : '○'}</span>
      <div className="dtp-evidence__body">
        <div><strong>{who}:</strong> {label}{p.note ? <span className="dtp-muted"> · {p.note}</span> : null}</div>
        {p.evidenceQuote && <div className="dtp-muted">«{p.evidenceQuote}» <span className="domain-badge">{EVIDENCE_LABEL[p.evidenceKind] ?? p.evidenceKind}</span></div>}
      </div>
    </div>
  );
}

function ClauseRow({ sheet, c, role, onChanged }: { sheet: Sheet; c: Clause; role: SheetRole; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revisions, setRevisions] = useState<any | null>(null);
  const mySide: TermsSide = role === 'candidate' ? 'CANDIDATE' : 'EMPLOYER';
  const other: TermsSide = mySide === 'CANDIDATE' ? 'EMPLOYER' : 'CANDIDATE';
  const isDraft = !c.confirmedAt && !c.rejectedAt;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); haptic('success'); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <li className="domain-entities__item">
      <button type="button" className="domain-entities__title" onClick={() => setOpen(!open)}>
        {c.text}
        {' '}
        <span className="domain-badge">{c.kind === 'REQUIREMENT' ? 'требование' : 'условие'}</span>
        {c.isRequired && <span className="dtp-badge dtp-badge--req"> обязательное</span>}
        {isDraft && <span className="dtp-badge dtp-badge--warn"> черновик</span>}
        {c.rejectedAt && <span className="dtp-badge dtp-badge--muted"> отклонён</span>}
        {c.kind === 'REQUIREMENT' && c.confirmedAt && (
          <span className="dtp-badge dtp-badge--muted"> {COVERAGE_LABEL[(c.side === 'EMPLOYER' ? c.current.CANDIDATE : c.current.EMPLOYER)?.coverage ?? 'unknown']}</span>
        )}
      </button>
      {open && (
        <div className="domain-entities__body">
          <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
          <p className="dtp-muted">
            Сторона: {SIDE_LABEL[c.side]}{c.category ? ` · ${c.category}` : ''}
            {c.sourceQuote ? <> · источник: «{c.sourceQuote}»</> : null}
            {c.sourceClauseId ? ' · унаследован из листа вакансии' : ''}
          </p>
          {isDraft && (
            <div className="entity-form__actions">
              <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.confirmClauses(sheet.id, [c.id]))}>Подтвердить пункт</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.rejectClauses(sheet.id, [c.id]))}>Отклонить</button>
            </div>
          )}
          {c.current.EMPLOYER && <PositionView p={c.current.EMPLOYER} who={SIDE_LABEL.EMPLOYER} />}
          {c.current.CANDIDATE && <PositionView p={c.current.CANDIDATE} who={SIDE_LABEL.CANDIDATE} />}
          {!c.current.EMPLOYER && !c.current.CANDIDATE && c.drafts.length === 0 && <p className="dtp-muted">Позиций пока нет — пункт не обсуждался.</p>}
          {c.drafts.length > 0 && (
            <>
              <h4>Черновики позиций (AI предложил — подтверждает человек)</h4>
              {c.drafts.map((d) => (
                <div key={d.id}>
                  <PositionView p={d} who={SIDE_LABEL[d.bySide]} />
                  <div className="entity-form__actions">
                    <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.confirmPositions(sheet.id, [d.id]))}>Подтвердить</button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.rejectPositions(sheet.id, [d.id]))}>Отклонить</button>
                  </div>
                </div>
              ))}
            </>
          )}
          {c.confirmedAt && !c.rejectedAt && (adding ? (
            <EntityForm
              fields={[
                { name: 'bySide', label: 'Чья позиция', type: 'select', required: true, options: [{ value: mySide, label: SIDE_LABEL[mySide] }, { value: other, label: `${SIDE_LABEL[other]} (со слов / из документа)` }] },
                ...(c.kind === 'REQUIREMENT'
                  ? [{ name: 'coverage', label: 'Покрытие', type: 'select' as const, required: true, options: (Object.keys(COVERAGE_LABEL) as Coverage[]).map((k) => ({ value: k, label: COVERAGE_LABEL[k] })) }]
                  : [{ name: 'stance', label: 'Отношение', type: 'select' as const, required: true, options: (Object.keys(STANCE_LABEL) as Stance[]).map((k) => ({ value: k, label: STANCE_LABEL[k] })) }]),
                { name: 'evidenceQuote', label: 'Опора — дословная цитата', type: 'textarea', required: true, hint: 'Без цитаты позиция не записывается' },
                { name: 'note', label: 'Заметка', type: 'text' },
              ]}
              initial={{ bySide: mySide }}
              submitLabel="Записать позицию"
              onCancel={() => setAdding(false)}
              onSubmit={async (v) => { await sheetsApi.addPosition(sheet.id, { clauseId: c.id, ...(v as any) }); setAdding(false); onChanged(); }}
            />
          ) : (
            <div className="entity-form__actions">
              <button type="button" className="secondary" onClick={() => setAdding(true)}>+ Позиция вручную</button>
              <button type="button" className="secondary" onClick={async () => { try { setRevisions(await sheetsApi.revisions(sheet.id, c.id)); } catch (e) { setError(e); } }}>Редакции</button>
            </div>
          ))}
          {revisions && <JsonView data={revisions} />}
        </div>
      )}
    </li>
  );
}

const EVIDENCE_OPTIONS = ['VACANCY_TEXT', 'OFFER_TEXT', 'CLIENT_BRIEF', 'OWN_DOCUMENT', 'PUBLIC_SOURCE', 'USER_STATED'].map((k) => ({ value: k, label: EVIDENCE_LABEL[k] }));

export function TermsSheetView({ sheetId, role, extras, intro }: { sheetId: string; role: SheetRole; extras?: (sheet: Sheet, refresh: () => void) => ReactNode; intro?: ReactNode }) {
  const { sheet, error, refresh } = useSheet(sheetId);
  const [tab, setTab] = useState<'clauses' | 'agenda' | 'offers' | 'extras'>('clauses');
  const [agenda, setAgenda] = useState<any[] | null>(null);
  const [mode, setMode] = useState<'none' | 'clause' | 'propose' | 'offer'>('none');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [offerDraft, setOfferDraft] = useState<any | null>(null);
  const [clarify, setClarify] = useState<{ questions: Array<{ clauseId: string; clauseText: string; question: string }>; note: string } | null>(null);
  const [result, setResult] = useState<any | null>(null);

  useEffect(() => { if (tab === 'agenda' && sheetId) sheetsApi.agenda(sheetId).then(setAgenda).catch((e) => setActionError(e)); }, [tab, sheetId, sheet]);

  if (error) return <AiErrorNotice error={error} />;
  if (!sheet) return <p className="dtp-muted">Загрузка листа…</p>;

  async function run(fn: () => Promise<unknown>, after?: (r: any) => void) {
    setBusy(true); setActionError(null);
    try { const r = await fn(); haptic('success'); after?.(r); refresh(); } catch (e) { setActionError(e); } finally { setBusy(false); }
  }

  const drafts = sheet.clauses.filter((c) => !c.confirmedAt && !c.rejectedAt);
  const bySide = (side: TermsSide) => sheet.clauses.filter((c) => c.side === side && !c.rejectedAt);
  const t = sheet.counters.total;

  return (
    <section className="domain-panel">
      {intro}
      <div className="dtp-facts">
        <div><span className="dtp-facts__label">Лист</span><strong>{sheet.title}</strong></div>
        <div><span className="dtp-facts__label">Вид</span><strong>{sheet.kind === 'VACANCY' ? 'вакансия' : sheet.kind === 'INTERVIEW' ? 'кандидат' : 'моё резюме под вакансию'}</strong></div>
        <div>
          <span className="dtp-facts__label">Статус</span>
          <select value={sheet.status} disabled={busy} onChange={(e) => run(() => sheetsApi.setStatus(sheet.id, e.target.value as SheetStatus))}>
            {/* Пункт [label-is-the-choice] 2026-09-06: здесь стояло
                `Object.entries(STATUS_LABEL)` — меню строилось из карты
                ПОДПИСЕЙ. Две строки из пяти сервер отвергал всегда
                (DRAFT запрещён явно, CLOSED вообще не существует), а
                настоящий WITHDRAWN в меню не попадал. Теперь список
                приходит с сервера, а карта отвечает только за слова. */}
            <option value={sheet.status}>{STATUS_LABEL[sheet.status] ?? sheet.status} — сейчас</option>
            {(sheet.allowedStatuses ?? []).map((k) => <option key={k} value={k}>{STATUS_LABEL[k] ?? k}</option>)}
          </select>
        </div>
        <div><span className="dtp-facts__label">Требования</span><strong>{t.covered} отражено · {t.partial} частично · {t.not_covered} нет · {t.unknown} не обсуждалось</strong></div>
      </div>
      <p className="dtp-hint">Это не оценка человека и не «процент соответствия» — счётчики того, какие пункты уже обсуждены и чем подтверждены. Решение принимаете вы.</p>
      <AiErrorNotice error={actionError} onConsentGranted={() => setActionError(null)} />

      <nav className="domain-tabs">
        {([['clauses', 'Пункты'], ['agenda', 'Повестка'], ['offers', `Оффер${sheet.offers.length ? ` (${sheet.offers.length})` : ''}`], ...(extras ? [['extras', role === 'candidate' ? 'Мои инструменты' : 'Инструменты']] : [])] as Array<[typeof tab, string]>).map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {tab === 'clauses' && (
        <>
          {drafts.length > 1 && (
            <div className="entity-form__actions">
              <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.confirmClauses(sheet.id, drafts.map((d) => d.id)))}>Подтвердить все черновики ({drafts.length})</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.rejectClauses(sheet.id, drafts.map((d) => d.id)))}>Отклонить все</button>
            </div>
          )}
          {(['EMPLOYER', 'CANDIDATE'] as TermsSide[]).map((side) => (
            <div key={side} className="dtp-section">
              <h3>{side === 'EMPLOYER' ? 'Работодатель: требования и условия' : 'Соискатель: требования и условия'}</h3>
              {bySide(side).length === 0 && <p className="card-section__empty">Пунктов нет.</p>}
              <ul className="domain-entities">
                {bySide(side).map((c) => <ClauseRow key={c.id} sheet={sheet} c={c} role={role} onChanged={refresh} />)}
              </ul>
            </div>
          ))}
          {result && (
            <div className="dtp-section">
              <h4>Результат</h4>
              {/* [draft-outcome] 2026-09-04: «Сверить с текстом» отдаёт
                  черновики позиций и то, что разобрать не удалось. Само
                  число не потерялось бы и в сыром JSON ниже, но читать
                  его там человек не обязан. */}
              <p className="dtp-muted">Черновиков позиций: {Array.isArray(result?.created) ? result.created.length : Array.isArray(result) ? result.length : '—'} — подтвердите их в списке пунктов.</p>
              {/* Пункт [failure-looks-empty] 2026-09-05: «Пары условий
                  (AI)» отдавали пустой список тремя разными путями —
                  сравнивать было нечего, модель не ответила, совпадений
                  нет, — и этот блок писал под всеми тремя одно и то же.
                  Подпись приходит с сервера: решение о том, состоялся ли
                  разбор, принимает тот, кто его запускал. */}
              {typeof result?.note === 'string' && result.note && (
                <p role="status" className="dtp-muted">{result.note}</p>
              )}
              {/* Пункт [input-truncated] 2026-09-05: до этой сверки
                  экран говорил, что потерялось ПОСЛЕ разбора, и молчал
                  о том, что до разбора не дошло. */}
              <IntakeNotes intake={result?.intake} storedIntake={result?.storedIntake} what="текст источника" />
              <DraftSkipsNotes skips={result?.skipped} />
              <JsonView data={result} />
              <button type="button" className="secondary" onClick={() => setResult(null)}>Скрыть</button>
            </div>
          )}
          {mode === 'none' && (
            <div className="entity-form__actions">
              <button type="button" className="secondary" onClick={() => setMode('clause')}>+ Пункт</button>
              <button type="button" className="secondary" onClick={() => setMode('propose')}>Сверить с текстом</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.proposeCounterparts(sheet.id), setResult)}>Пары условий (AI)</button>
            </div>
          )}
          {mode === 'clause' && (
            <EntityForm
              fields={[
                { name: 'side', label: 'Сторона', type: 'select', required: true, options: [{ value: 'EMPLOYER', label: SIDE_LABEL.EMPLOYER }, { value: 'CANDIDATE', label: SIDE_LABEL.CANDIDATE }] },
                { name: 'kind', label: 'Вид', type: 'select', required: true, options: [{ value: 'REQUIREMENT', label: 'требование (закрывается фактами)' }, { value: 'CONDITION', label: 'условие (обсуждается)' }] },
                { name: 'text', label: 'Формулировка', type: 'textarea', required: true },
                { name: 'category', label: 'Категория', type: 'text' },
                { name: 'isRequired', label: 'Обязательный', type: 'bool' },
              ]}
              initial={{ side: role === 'candidate' ? 'CANDIDATE' : 'EMPLOYER', kind: 'REQUIREMENT' }}
              submitLabel="Добавить пункт"
              onCancel={() => setMode('none')}
              onSubmit={async (v) => { await sheetsApi.addClause(sheet.id, v as any); setMode('none'); refresh(); }}
            />
          )}
          {mode === 'propose' && (
            <EntityForm
              fields={[
                { name: 'evidenceKind', label: 'Что это за текст', type: 'select', required: true, options: EVIDENCE_OPTIONS },
                { name: 'bySide', label: 'Чьи позиции извлекать', type: 'select', options: [{ value: 'EMPLOYER', label: SIDE_LABEL.EMPLOYER }, { value: 'CANDIDATE', label: SIDE_LABEL.CANDIDATE }] },
                { name: 'text', label: 'Текст источника', type: 'textarea', required: true, hint: 'AI предложит черновики позиций с цитатами из этого текста; подтверждаете вы' },
              ]}
              initial={{ evidenceKind: 'OFFER_TEXT', bySide: role === 'candidate' ? 'EMPLOYER' : 'CANDIDATE' }}
              submitLabel="Предложить позиции"
              onCancel={() => setMode('none')}
              onSubmit={async (v) => { const r = await sheetsApi.propose(sheet.id, v as any); setResult(r); setMode('none'); refresh(); }}
            />
          )}
        </>
      )}

      {tab === 'agenda' && (
        <div className="dtp-section">
          <p className="dtp-hint">Повестка — что ещё не обсуждено или открыто. Порядок ваш; «важности» пунктов приложение не присваивает.</p>
          {!agenda && <p className="dtp-muted">Загрузка…</p>}
          {agenda && agenda.length === 0 && <p className="card-section__empty">Открытых пунктов нет.</p>}
          <ul>{(agenda ?? []).map((a) => <li key={a.clauseId}><strong>{a.text}</strong> <span className="dtp-muted">· {SIDE_LABEL[a.side as TermsSide]} · {a.kind === 'REQUIREMENT' ? 'требование' : 'условие'}{a.isRequired ? ' · обязательное' : ''}</span></li>)}</ul>
          {/* К-5: из списка пунктов — готовые вопросы, которые можно отправить
              письмом как есть. Вопросы, а не «красные флаги»: выводов о
              работодателе продукт не делает. */}
          {agenda && agenda.length > 0 && (
            <div className="entity-form__actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.clarifyingQuestions(sheet.id), setClarify)}>
                {busy ? '…' : 'Сформулировать вопросы'}
              </button>
            </div>
          )}
          {clarify && (
            <div className="dtp-card">
              <div className="dtp-card__head dtp-card__head--static"><span>Что уточнить</span><button type="button" className="dtp-link" onClick={() => setClarify(null)}>скрыть</button></div>
              <div className="dtp-card__body">
                <p className="dtp-status dtp-status--warn">{clarify.note}</p>
                <ul>{clarify.questions.map((q) => <li key={q.clauseId}>{q.question}<br /><span className="dtp-muted">по пункту: {q.clauseText}</span></li>)}</ul>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'offers' && (
        <div className="dtp-section">
          <p className="dtp-hint">Оффер — документ, а не «результат»: его текст сверяется с пунктами листа и с тем, что обещали на собеседованиях.</p>
          {sheet.offers.length === 0 && <p className="card-section__empty">Офферов пока нет.</p>}
          {sheet.offers.map((o) => (
            <div key={o.id} className="dtp-card">
              <div className="dtp-card__head dtp-card__head--static">
                <span>{o.source ?? 'оффер'} · {new Date(o.createdAt).toLocaleDateString('ru-RU')}</span>
                <span className="domain-badge">{o.withdrawnAt ? 'отозван' : o.reviewedAt ? 'проверен' : 'черновик'}{o.sharedFromProjectId ? ' · копия от работодателя' : ''}</span>
              </div>
              <div className="dtp-card__body"><pre className="script-text">{o.rawText}</pre></div>
            </div>
          ))}
          {offerDraft && (
            <div className="dtp-card">
              <div className="dtp-card__head dtp-card__head--static"><span>Черновик оффера из согласованных пунктов (А-1)</span></div>
              <div className="dtp-card__body">
                <pre className="script-text">{offerDraft.text ?? JSON.stringify(offerDraft, null, 2)}</pre>
                <p className="dtp-muted">Собран детерминированно из подтверждённых пунктов — без AI. Сохранить как документ можно кнопкой «+ Оффер».</p>
              </div>
            </div>
          )}
          {mode === 'offer' ? (
            <EntityForm
              fields={[{ name: 'rawText', label: 'Текст оффера', type: 'textarea', required: true }, { name: 'source', label: 'Источник (письмо, документ…)', type: 'text' }]}
              initial={offerDraft?.text ? { rawText: offerDraft.text, source: 'черновик из листа' } : undefined}
              submitLabel="Сохранить оффер"
              onCancel={() => setMode('none')}
              onSubmit={async (v) => { await sheetsApi.addOffer(sheet.id, v as any); setMode('none'); setOfferDraft(null); refresh(); }}
            />
          ) : (
            <div className="entity-form__actions">
              <button type="button" className="secondary" onClick={() => setMode('offer')}>+ Оффер</button>
              {role === 'team' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.offerDraft(sheet.id), setOfferDraft)}>Черновик оффера из листа</button>}
            </div>
          )}
        </div>
      )}

      {tab === 'extras' && extras && <div className="dtp-section">{extras(sheet, refresh)}</div>}
    </section>
  );
}

/** Кнопка/панель «открыть или продолжить лист» по опоре — 409 на второй лист
 * бэкенд возвращает с existingSheetId; экран просто открывает существующий. */
export function useOpenSheet() {
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function open(fn: () => Promise<{ id: string }>, fallback?: () => Promise<Array<{ id: string }>>) {
    setBusy(true); setError(null);
    try {
      const s = await fn();
      setSheetId(s.id);
    } catch (e) {
      const existing = (e as any)?.details?.existingSheetId as string | undefined;
      if (existing) setSheetId(existing);
      else if (fallback && (e as any)?.httpStatus === 409) {
        try { const list = await fallback(); if (list[0]) setSheetId(list[0].id); else setError(e); } catch (e2) { setError(e2); }
      } else setError(e);
    } finally { setBusy(false); }
  }
  return { sheetId, setSheetId, error, busy, open };
}
