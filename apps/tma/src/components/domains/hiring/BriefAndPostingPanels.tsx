'use client';

// Пункт [job-domain-v2] — две панели команды (агентство и работодатель одним
// кодом): «Бриф» (§6.5: дословный текст → черновики пунктов листа вакансии с
// цитатой, вопросы автору, compliance с деловой альтернативой, диф брифов
// повторного заказчика — только агентство) и «Текст вакансии» (связка Т:
// черновик из листа, редакции с дифом, проверки, трассировка пункт → цитата
// брифа, вопросы читателя, варианты по каналам и языкам, чеклист публикации,
// согласование по ссылке — только агентство). Чеклист не блокирует —
// показывает открытое; решение публиковать — за человеком.
import { useEffect, useState } from 'react';
import { briefApi, postingApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { ShareLinkView } from '../InterviewPoolWorkspace';
import { haptic } from '../../../lib/telegram';
import { SkippedNote, DraftSkipsNotes, IntakeNotes } from '../../SkippedNotes';
import { TranslationCheckNote } from '../../TranslationCheckNote';

export type TeamRole = 'agency' | 'employer';

function useRun(after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  async function run<T>(fn: () => Promise<T>, title?: string, then?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); if (title) setOut({ title, data: r }); then?.(r); after?.(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return { busy, error, setError, out, setOut, run };
}

function ResultCard({ out, onClose }: { out: { title: string; data: any } | null; onClose: () => void }) {
  if (!out) return null;
  const d = out.data;
  return (
    <div className="dtp-card">
      <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={onClose}>скрыть</button></div>
      <div className="dtp-card__body">
        {d?.frame && <p className="dtp-status dtp-status--warn">{d.frame}</p>}
        {/* [dropped-quotes] 2026-09-04: подпись стоит НАД списком и одна на
            всю карточку — иначе «Compliance-флагов нет» ниже читается как
            «проверено, чисто», хотя часть находок отброшена за неточную
            цитату. Ноль не печатается вовсе. */}
        <SkippedNote skipped={d?.skippedWithoutQuote} />
        {/* [draft-outcome] 2026-09-04: «Черновиков пунктов листа вакансии:
            N» из брифа заказчика человек читает как «вот что в брифе
            есть». Не разобранное названо здесь — с причинами, потому что
            «упёрлись в предел 40» это единственный случай, где ему есть
            что сделать: разбить текст. */}
        <IntakeNotes intake={d?.intake ?? d?.complianceIntake} storedIntake={d?.storedIntake} what="текст" />
        <DraftSkipsNotes skips={d?.draftSkips} />
        {Array.isArray(d?.items) ? (
          <ul>{d.items.map((i: any) => <li key={i.key}>{i.ok ? '✓' : '○'} {i.label}</li>)}</ul>
        ) : Array.isArray(d?.complianceFlags) ? (
          <>
            {d.complianceFlags.length === 0 && <p className="card-section__empty">Compliance-флагов нет.</p>}
            <ul>{d.complianceFlags.map((f: any) => <li key={f.id ?? f.quotedText}><strong>{f.category}</strong>: «{f.quotedText}»{f.alternativeText ? <> → <em>{f.alternativeText}</em></> : null}{f.norm ? <span className="dtp-muted"> · {f.norm}</span> : null}{f.note ? <span className="dtp-muted"> · {f.note}</span> : null}</li>)}</ul>
            {d.checks && <JsonView data={d.checks} />}
          </>
        ) : Array.isArray(d?.questions) ? (
          <ul>{d.questions.map((q: any, i: number) => <li key={i}>{typeof q === 'string' ? q : q.question ?? q.text}{q.reason ? <span className="dtp-muted"> · {q.reason}</span> : null}</li>)}</ul>
        ) : Array.isArray(d?.proposedClauses) ? (
          <p>Черновиков пунктов листа вакансии: {d.proposedClauses.length} — подтвердите их на вкладке «Лист вакансии».</p>
        ) : <JsonView data={d} />}
      </div>
    </div>
  );
}

export function ClientBriefPanel({ projectId, role, onChanged }: { projectId: string; role: TeamRole; onChanged?: () => void }) {
  const [briefs, setBriefs] = useState<any[] | null>(null);
  const [tick, setTick] = useState(0);
  const { busy, error, setError, out, setOut, run } = useRun(() => { setTick((t) => t + 1); onChanged?.(); });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { briefApi.list(projectId).then(setBriefs).catch(setError); }, [projectId, tick, setError]);

  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <p className="card-section__empty">
        {role === 'agency'
          ? 'Бриф заказчика хранится дословно. Из него AI предлагает пункты листа вакансии с цитатой; вы подтверждаете. Вопросы автору брифа — что осталось неясным; compliance — какие формулировки лучше заменить и на что.'
          : 'Внутренний бриф — ваш рассказ о вакансии (онбординг или текст). Из него AI предлагает пункты листа вакансии с цитатой; вы подтверждаете. Compliance подсказывает деловую альтернативу спорным формулировкам.'}
      </p>
      {briefs && briefs.length === 0 && <p className="card-section__empty">Брифов пока нет.</p>}
      <ul className="domain-entities">
        {(briefs ?? []).map((b: any) => (
          <li key={b.id} className="domain-entities__item">
            <button type="button" className="domain-entities__title" onClick={() => setOpenId(openId === b.id ? null : b.id)}>
              {b.source ?? (b.origin === 'INTERNAL' ? 'внутренний бриф' : 'бриф заказчика')} · {new Date(b.createdAt).toLocaleDateString('ru-RU')}
              <span className="domain-badge">{b.extractedAt ? 'пункты предложены' : 'не разобран'}</span>
            </button>
            {openId === b.id && (
              <div className="domain-entities__body">
                <pre className="script-text">{b.rawText}</pre>
                <div className="entity-form__actions">
                  <button type="button" className="primary" disabled={busy} onClick={() => run(() => briefApi.extract(b.id), 'Пункты из брифа')}>Предложить пункты листа</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => run(() => briefApi.questions(b.id), 'Вопросы автору брифа')}>Вопросы автору</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => run(() => briefApi.compliance(b.id), 'Compliance брифа')}>Compliance</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <EntityForm
          fields={[{ name: 'rawText', label: 'Текст брифа — как есть', type: 'textarea', required: true }, { name: 'source', label: 'Откуда (письмо, звонок…)', type: 'text' }]}
          submitLabel="Сохранить бриф" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await briefApi.ingest(projectId, { ...(v as any), origin: role === 'employer' ? 'INTERNAL' : 'EXTERNAL' }); setAdding(false); setTick((t) => t + 1); onChanged?.(); }}
        />
      ) : (
        <div className="entity-form__actions">
          <button type="button" className="secondary" onClick={() => setAdding(true)}>+ Бриф</button>
          {role === 'agency' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => briefApi.diff(projectId), 'Что изменилось у заказчика с прошлого раза')}>Диф с прошлым брифом заказчика</button>}
        </div>
      )}
      <ResultCard out={out} onClose={() => setOut(null)} />
    </section>
  );
}

const CHANNEL_LABEL: Record<string, string> = { full: 'полный', short: 'короткий', telegram: 'для Telegram', career_page: 'для карьерной страницы' };

export function VacancyPostingPanel({ projectId, role, onChanged }: { projectId: string; role: TeamRole; onChanged?: () => void }) {
  const [posting, setPosting] = useState<any | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const { busy, error, setError, out, setOut, run } = useRun(() => { setTick((t) => t + 1); onChanged?.(); });
  const [editing, setEditing] = useState(false);
  const [revId, setRevId] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  useEffect(() => { postingApi.get(projectId).then((p) => { setPosting(p); if (p?.revisions?.length && !revId) setRevId(p.revisions[p.revisions.length - 1].id); }).catch(setError); }, [projectId, tick, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  const revisions: any[] = posting?.revisions ?? [];
  const rev = revisions.find((r) => r.id === revId) ?? revisions[revisions.length - 1] ?? null;
  const variants: any[] = (posting?.variants ?? []).filter((v: any) => !rev || v.derivedFromRevisionId === rev.id);

  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {link && <ShareLinkView link={link.link} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      <p className="card-section__empty">Текст вакансии собирается из подтверждённых пунктов листа: структура — детерминированно, формулировки — AI, каждая правка — новая редакция с дифом. Проверки и чеклист показывают открытое, но не блокируют: публиковать или нет — решаете вы.</p>
      {posting === undefined && <p className="dtp-muted">Загрузка…</p>}
      {posting === null && (
        <button type="button" className="primary" disabled={busy} onClick={() => run(() => postingApi.draft(projectId))}>Собрать черновик из листа вакансии</button>
      )}
      {posting && (
        <>
          {revisions.length > 1 && (
            <label>Редакция<br />
              <select value={rev?.id ?? ''} onChange={(e) => setRevId(e.target.value)}>
                {revisions.map((r, i) => <option key={r.id} value={r.id}>#{i + 1} · {new Date(r.createdAt).toLocaleString('ru-RU')}{r.reviewedAt ? ' · утверждена' : ''}</option>)}
              </select>
            </label>
          )}
          {rev && (
            <>
              <div className="dtp-card">
                <div className="dtp-card__head dtp-card__head--static"><span>Редакция от {new Date(rev.createdAt).toLocaleString('ru-RU')}</span><span className="domain-badge">{rev.reviewedAt ? 'утверждена' : 'черновик'}</span></div>
                <div className="dtp-card__body">
                  {editing ? (
                    <EntityForm
                      fields={[{ name: 'text', label: 'Текст', type: 'textarea', required: true }]}
                      initial={{ text: rev.text }} submitLabel="Сохранить как новую редакцию" onCancel={() => setEditing(false)}
                      onSubmit={async (v) => { const r = await postingApi.addRevision(projectId, String(v.text)); setEditing(false); setRevId(r.id); setTick((t) => t + 1); }}
                    />
                  ) : <pre className="script-text">{rev.text}</pre>}
                  {posting.journal && posting.journal.find((j: any) => j.id === rev.id)?.diff && (
                    <details><summary>Что изменилось с прошлой редакции</summary><JsonView data={posting.journal.find((j: any) => j.id === rev.id).diff} /></details>
                  )}
                </div>
              </div>
              <div className="entity-form__actions">
                <button type="button" className="secondary" onClick={() => setEditing(true)}>Править</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.check(rev.id), 'Проверки текста')}>Проверить</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.trace(rev.id), 'Откуда каждый пункт')}>Трассировка</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.readerQuestions(rev.id), 'Вопросы читателя')}>Вопросы читателя</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.publishChecklist(rev.id), 'Чеклист публикации')}>Чеклист</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.variants(rev.id, { channels: ['short', 'telegram'], langs: [] }), 'Варианты')}>Варианты (короткий, Telegram)</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.variants(rev.id, { channels: ['full'], langs: ['uk', 'en'] }), 'Языковые версии')}>Языковые версии (uk, en)</button>
                {!rev.reviewedAt && <button type="button" className="primary" disabled={busy} onClick={() => run(() => postingApi.review(rev.id))}>Утвердить редакцию</button>}
                {role === 'agency' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.reviewShare(rev.id), undefined, (r: any) => setLink({ link: `${window.location.origin}/posting-review/${r.token}`, expiresAt: r.expiresAt ?? '' }))}>Ссылка на согласование заказчику</button>}
              </div>
              {!rev.checks?.salaryDisclosed && rev.checks && !rev.checks.salaryOmissionReason && (
                <EntityForm
                  fields={[{ name: 'reason', label: 'Оплата в тексте не названа — почему', type: 'text', required: true, hint: 'Причина попадёт в чеклист публикации' }]}
                  submitLabel="Записать причину"
                  onSubmit={async (v) => { await postingApi.salaryOmission(rev.id, String(v.reason)); setTick((t) => t + 1); }}
                />
              )}
              {variants.length > 0 && (
                <>
                  <h3>Варианты этой редакции</h3>
                  {variants.map((v: any) => (
                    <div key={v.id} className="dtp-card">
                      <div className="dtp-card__head dtp-card__head--static"><span>{CHANNEL_LABEL[v.channel] ?? v.channel} · {String(v.lang).toUpperCase()}</span><span className="domain-badge">{v.reviewedAt ? 'сверен' : 'не сверен'}</span></div>
                      <div className="dtp-card__body">
                        <pre className="script-text">{v.text}</pre>
                        {/* Пункт [translated-adds] 2026-09-06: вторая копия той же
                            строки — и та же подмена проверки самоотчётом. */}
                        <TranslationCheckNote backCheck={v.backCheck} unverifiable={(v as any).backCheckUnverifiable} />
                        {!v.reviewedAt && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => postingApi.reviewVariant(v.id))}>Сверил(а), утвердить</button>}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
      <ResultCard out={out} onClose={() => setOut(null)} />
    </section>
  );
}
