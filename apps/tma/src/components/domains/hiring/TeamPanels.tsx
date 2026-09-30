'use client';

// Пункт [job-domain-v2] — панели команды над листами кандидатов: матрица
// покрытия «кандидаты × пункты» без столбца «итог» (А-3), «кому обещали и
// молчим» (А-7), экспорт для bias-аудита (А-9), а у работодателя — слияние
// кандидата, пришедшего двумя путями (Р-8), уведомление об AI от имени компании
// (Р-12) и чеклист закрытия вакансии (Р-14). Engagement (Р-4/Р-15): работодатель
// приглашает агентство и получает отчёты; агентство видит, что ему передано.
import { useEffect, useState } from 'react';
import { COVERAGE_LABEL, employerApi, sheetsApi } from '../../../lib/hiring/api';
import { domainApi } from '../../../lib/domains/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { ShareLinkView } from '../InterviewPoolWorkspace';
import { haptic } from '../../../lib/telegram';
import { MergeReport, MergeOutcome } from '../../MergeReport';
import type { TeamRole } from './BriefAndPostingPanels';

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setError(null); fn().then(setData).catch(setError); }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, refresh: () => setTick((t) => t + 1) };
}

/** Пункт [computed-for-the-person-never-shown] 2026-09-30 — два текста,
 *  которые сервер считал, а экран не показывал.
 *
 *  Отдельными компонентами НАРОЧНО: внутри панели их держит `useAsync`,
 *  и нарисовать их в проверке было бы нечем — осталась бы сверка по
 *  тексту исходника, то есть проверка УПОМИНАНИЯ, а не поведения.
 *  Мутация «спрятать число за `false`» такую сверку проходила насквозь;
 *  эти компоненты её роняют. */
export function RevokedRowsNote({ count }: { count: number }) {
  if (!count) return null;
  return (
    <p className="dtp-status dtp-status--warn" role="status">
      Строк без покрытия из-за отозванного согласия: {count}. Это не пробел в данных — так выглядит исполненная просьба кандидата.
    </p>
  );
}

/** Первая ячейка строки кандидата. У отозвавшего согласие строка пустая
 *  НАМЕРЕННО (Пункт [revocation-not-one-rule]) — и обязана объяснять,
 *  почему она пустая, иначе читается как «по кандидату ничего нет». */
export function CandidateCell({ row }: { row: { displayName?: string; stage?: string; consentRevoked?: boolean; note?: string; openQuestions?: unknown[] } }) {
  const open = row.openQuestions?.length ?? 0;
  return (
    <td>
      <strong>{row.displayName}</strong>
      <br />
      <span className="dtp-muted">{row.stage}</span>
      {row.consentRevoked ? (
        <><br /><span className="dtp-status dtp-status--warn">{row.note}</span></>
      ) : open > 0 ? (
        <><br /><span className="dtp-muted">не обсуждено: {open}</span></>
      ) : null}
    </td>
  );
}

export function CoverageMatrixPanel({ projectId }: { projectId: string }) {
  const { data, error } = useAsync(() => sheetsApi.coverageMatrix(projectId), [projectId]);
  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} />
      <p className="card-section__empty">Столбцы — требования вакансии, строки — кандидаты с открытым листом. В ячейке — отражено ли требование в источниках кандидата и чем. Столбца «итог» нет намеренно: сравнивать людей по сумме галочек — не задача приложения. Порядок строк вы меняете сами.</p>
      {/* Число пустующих строк сервер считает с 2026-09-06 и никуда не
          отдавал: матрица выглядела полной при том, что часть пула из
          неё выпала. */}
      <RevokedRowsNote count={data?.revokedRows ?? 0} />
      {!data && !error && <p className="dtp-muted">Загрузка…</p>}
      {data && data.rows.length === 0 && <p className="card-section__empty">Ни у одного кандидата ещё нет листа — откройте лист кандидата на вкладке «Кандидаты».</p>}
      {data && data.rows.length > 0 && (
        <div className="domain-table-wrap">
          <table className="domain-table dtp-table dtp-table--matrix">
            <thead><tr><th>Кандидат</th>{data.columns.map((c: any) => <th key={c.clauseId}>{c.text}{c.isRequired ? ' *' : ''}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.candidateProfileId}>
                  {/* Пункт [computed-for-the-person-never-shown] 2026-09-30:
                      строка отозвавшего согласие приходит с `consentRevoked`
                      и текстом `note` — их завёл Пункт [revocation-not-one-rule]
                      именно затем, чтобы пустая строка не читалась как «по
                      кандидату ничего нет». Экран не рисовал ни то, ни
                      другое: человек видел строку из одних прочерков без
                      единого слова о причине. */}
                  <CandidateCell row={r} />
                  {data.columns.map((c: any) => { const cell = r.cells[c.clauseId]; return <td key={c.clauseId} title={cell?.quote ?? ''}>{COVERAGE_LABEL[cell?.coverage] ?? '—'}{cell?.quote ? <><br /><span className="dtp-muted">«{cell.quote.slice(0, 60)}{cell.quote.length > 60 ? '…' : ''}»</span></> : null}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.note && <p className="dtp-hint">{data.note}</p>}
    </section>
  );
}

export function ProcessDisciplinePanel({ projectId, role }: { projectId: string; role: TeamRole }) {
  const [days, setDays] = useState(7);
  const { data, error, refresh } = useAsync(() => sheetsApi.silence(projectId, days), [projectId, days]);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>, title: string) {
    setBusy(true); setErr(null);
    try { setOut({ title, data: await fn() }); haptic('success'); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <section className="domain-panel">
      <AiErrorNotice error={error ?? err} onConsentGranted={() => setErr(null)} />
      <p className="card-section__empty">Дисциплина процесса, а не KPI: кто из кандидатов ждёт ответа дольше N дней и какие обещания просрочены. Рейтингов рекрутеров здесь нет.</p>
      <label>Ждут дольше, дней <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value) || 7)} /></label>
      {data && (
        <>
          <h3>Ждут ответа</h3>
          {data.waiting.length === 0 ? <p className="card-section__empty">Никто не ждёт дольше {days} дней.</p> : <ul>{data.waiting.map((w: any) => <li key={w.candidateProfileId}>{w.displayName} — с {new Date(w.since).toLocaleDateString('ru-RU')}</li>)}</ul>}
          <h3>Просроченные обещания</h3>
          {data.overduePromises.length === 0 ? <p className="card-section__empty">Просроченных обещаний нет.</p> : <ul>{data.overduePromises.map((p: any) => <li key={p.id}>{p.displayName ?? '—'}: {p.description} — к {p.dueDate ? new Date(p.dueDate).toLocaleDateString('ru-RU') : '—'}</li>)}</ul>}
        </>
      )}
      <div className="entity-form__actions">
        <button type="button" className="secondary" onClick={refresh}>Обновить</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.biasExport(projectId), 'Данные для внешнего bias-аудита')}>Экспорт для bias-аудита</button>
        {role === 'employer' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.closingChecklist(projectId), 'Закрытие вакансии: что осталось')}>Чеклист закрытия вакансии</button>}
      </div>
      {out && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div>
          <div className="dtp-card__body">
            {(out.data?.note || out.data?.frame) && <p className="dtp-status dtp-status--warn">{out.data.note ?? out.data.frame}</p>}
            {/* Пункт [log-says-we-saw-it] 2026-09-24: под пустым списком
                здесь стояло «Всем ответили.» — утверждение о живых людях,
                собранное из нажатий кнопки «отметить». Продукт письма не
                отправляет и знает ровно одно: у всех есть отметка. Это и
                говорится. */}
            {Array.isArray(out.data?.candidatesAnswerNotMarked) ? (
              <>
                <h4>У кого нет отметки об отправленном письме-статусе</h4>
                {out.data.candidatesAnswerNotMarked.length === 0 ? <p className="card-section__empty">Отметка есть у всех — со слов рекрутера; отправку продукт не проверяет.</p> : <ul>{out.data.candidatesAnswerNotMarked.map((c: any) => <li key={c.candidateProfileId}>{c.displayName} · {c.stage}</li>)}</ul>}
                <h4>Открытые обещания</h4>
                {out.data.openCommitments.length === 0 ? <p className="card-section__empty">Нет.</p> : <ul>{out.data.openCommitments.map((c: any) => <li key={c.id}>{c.description}</li>)}</ul>}
                <p className="dtp-muted">Активных передач агентству: {out.data.activeEngagements.length} · активных ссылок на профили: {out.data.activeShares.length}</p>
              </>
            ) : <JsonView data={Object.fromEntries(Object.entries(out.data ?? {}).filter(([k]) => k !== 'note' && k !== 'frame'))} />}
          </div>
        </div>
      )}
    </section>
  );
}

/** Р-8 + Р-12 — только у работодателя. */
export function EmployerCandidateTools({ projectId, statuses, onChanged }: { projectId: string; statuses: any[]; onChanged: () => void }) {
  const [mode, setMode] = useState<'none' | 'merge' | 'notice'>('none');
  const [notice, setNotice] = useState<any | null>(null);
  const [merged, setMerged] = useState<MergeOutcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const opts = statuses.map((s) => ({ value: s.id, label: s.candidateProfile?.displayName ?? s.id }));
  return (
    <div className="dtp-section">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <div className="entity-form__actions">
        <button type="button" className="secondary" onClick={() => setMode('merge')}>Слить дубли одного кандидата</button>
        <button type="button" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { setNotice(await sheetsApi.aiNotice(projectId)); setMode('notice'); } catch (e) { setError(e); } finally { setBusy(false); } }}>Уведомление об AI кандидатам</button>
      </div>
      {mode === 'merge' && (
        <>
          {/* Пункт [silent-destruction] 2026-09-04: слияние НЕОБРАТИМО —
              вторая карточка удаляется вместе со своим листом. Раньше об
              этом не было сказано ни до, ни после: результат вызова
              выбрасывался, и человек получал только вибрацию. */}
          <p className="dtp-hint">Один человек пришёл и от агентства, и напрямую — позиции обоих листов собираются в один с пометкой источника. Расхождения остаются цитатами; «кто прав» приложение не решает.</p>
          <p className="dtp-status dtp-status--warn" role="status">Действие необратимо: присоединяемая карточка удаляется вместе со своим листом. Позиции переносятся только по пунктам, которые есть в обоих листах, — что не перенеслось, будет названо после слияния.</p>
          <EntityForm
            fields={[{ name: 'keepStatusId', label: 'Оставить', type: 'select', required: true, options: opts }, { name: 'mergeStatusId', label: 'Присоединить и убрать', type: 'select', required: true, options: opts }]}
            submitLabel="Слить" onCancel={() => setMode('none')}
            onSubmit={async (v) => { setMerged(await sheetsApi.mergeCandidates(projectId, v as any)); setMode('none'); haptic('success'); onChanged(); }}
          />
        </>
      )}
      <MergeReport outcome={merged} />
      {mode === 'notice' && notice && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>Уведомление об использовании AI · версия {notice.version}</span><button type="button" className="dtp-link" onClick={() => setMode('none')}>скрыть</button></div>
          <div className="dtp-card__body">
            <pre className="script-text">{notice.text}</pre>
            <ul>{notice.consents.map((c: any) => <li key={c.key}>{c.text}</li>)}</ul>
            <p className="dtp-hint">{notice.frame}. Отметьте, кому показали — факт показа с версией уходит в журнал.</p>
            <EntityForm
              fields={[{ name: 'candidateProfileId', label: 'Кандидат', type: 'select', required: true, options: statuses.map((s) => ({ value: s.candidateProfileId ?? s.candidateProfile?.id, label: s.candidateProfile?.displayName ?? s.id })) }]}
              submitLabel="Показано кандидату"
              onSubmit={async (v) => { await sheetsApi.aiNoticeShown(projectId, String(v.candidateProfileId), true); haptic('success'); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const SHARED_ITEMS: Array<[string, string]> = [['brief', 'бриф'], ['config', 'параметры вакансии'], ['questionnaire', 'анкета'], ['posting', 'текст вакансии']];
const ENGAGEMENT_STATUS: Record<string, string> = { PENDING: 'ожидает принятия', ACTIVE: 'активна', REVOKED: 'отозвана', CLOSED: 'закрыта' };

export function EngagementsPanel({ projectId, role }: { projectId: string; role: TeamRole }) {
  const { data, error, refresh } = useAsync(() => (role === 'employer' ? employerApi.engagements(projectId) : employerApi.agencyEngagements(projectId)), [projectId, role]);
  const reports = useAsync(() => (role === 'employer' ? employerApi.deliveredReports(projectId) : Promise.resolve([] as any[])), [projectId, role]);
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [deliverFor, setDeliverFor] = useState<string | null>(null);
  const [myReports, setMyReports] = useState<any[] | null>(null);
  const [followUpFor, setFollowUpFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<any[] | null>(null);

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setErr(null);
    try { const r = await fn(); haptic('success'); after?.(r); refresh(); reports.refresh(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <section className="domain-panel">
      <AiErrorNotice error={error ?? err} onConsentGranted={() => setErr(null)} />
      {link && <ShareLinkView link={link.link} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      <p className="card-section__empty">
        {role === 'employer'
          ? 'Передача вакансии агентству: вы выбираете, что именно уходит (ровно эти материалы копируются в проект агентства), получаете отчёты по кандидатам после проверки агентством и можете отозвать передачу — новые данные перестают поступать.'
          : 'Что передал заказчик-работодатель по этой вакансии, и куда уходят ваши отчёты. Отчёт доставляется только после вашего ревью; follow-up кандидату идёт через вас.'}
      </p>
      {data && data.length === 0 && <p className="card-section__empty">{role === 'employer' ? 'Агентство не приглашено.' : 'Этот проект не связан с проектом работодателя.'}</p>}
      <ul className="domain-entities">
        {(data ?? []).map((e: any) => (
          <li key={e.id} className="domain-entities__item">
            <div className="domain-entities__title">
              {ENGAGEMENT_STATUS[e.status] ?? e.status} · передано: {(e.sharedItems ?? []).map((k: string) => SHARED_ITEMS.find(([x]) => x === k)?.[1] ?? k).join(', ') || '—'}
              {e.expiresAt && <span className="dtp-muted"> · до {new Date(e.expiresAt).toLocaleDateString('ru-RU')}</span>}
            </div>
            <div className="domain-entities__body">
              <div className="entity-form__actions">
                {role === 'employer' && e.status !== 'REVOKED' && e.status !== 'CLOSED' && <button type="button" className="secondary" disabled={busy} onClick={() => { if (window.confirm('Отозвать передачу? Агентство перестанет получать новое; уже переданное остаётся у него как копия.')) void run(() => employerApi.revoke(e.id)); }}>Отозвать</button>}
                {role === 'employer' && e.status === 'ACTIVE' && <button type="button" className="secondary" onClick={async () => { setFollowUpFor(e.id); try { setCandidates(await domainApi.getJson(`/interview-pool/projects/${projectId}/candidates`)); } catch (er) { setErr(er); } }}>Follow-up кандидату через агентство</button>}
                {role === 'agency' && e.status === 'ACTIVE' && <button type="button" className="secondary" onClick={async () => { setDeliverFor(e.id); try { setMyReports(await domainApi.getJson(`/client-reports/projects/${projectId}`)); } catch (er) { setErr(er); } }}>Доставить отчёт заказчику</button>}
                {role === 'agency' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => employerApi.agencyPosting(e.id), (r) => setOut({ title: 'Текст вакансии заказчика', data: r }))}>Текст вакансии заказчика</button>}
              </div>
              {followUpFor === e.id && candidates && (
                <EntityForm
                  fields={[{ name: 'candidateProfileId', label: 'Кандидат', type: 'select', required: true, options: candidates.map((s: any) => ({ value: s.candidateProfileId ?? s.candidateProfile?.id, label: s.candidateProfile?.displayName ?? s.id })) }, { name: 'text', label: 'Что уточнить', type: 'textarea', required: true }]}
                  submitLabel="Отправить агентству" onCancel={() => setFollowUpFor(null)}
                  onSubmit={async (v) => { await employerApi.followUp(e.id, v as any); setFollowUpFor(null); haptic('success'); }}
                />
              )}
              {deliverFor === e.id && myReports && (
                <EntityForm
                  fields={[{ name: 'reportId', label: 'Отчёт (только проверенные)', type: 'select', required: true, options: myReports.filter((r: any) => r.reviewedAt).map((r: any) => ({ value: r.id, label: `${r.type ?? 'отчёт'} · ${new Date(r.draftedAt ?? r.createdAt).toLocaleDateString('ru-RU')}` })) }]}
                  submitLabel="Доставить" onCancel={() => setDeliverFor(null)}
                  onSubmit={async (v) => { await employerApi.deliver(e.id, String(v.reportId)); setDeliverFor(null); haptic('success'); }}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {role === 'employer' && (inviting ? (
        <EntityForm
          fields={[
            ...SHARED_ITEMS.map(([k, l]) => ({ name: `item_${k}`, label: `Передать: ${l}`, type: 'bool' as const })),
            { name: 'expiresAt', label: 'Срок действия приглашения', type: 'date' },
          ]}
          initial={{ item_brief: true, item_config: true, item_questionnaire: true, item_posting: false }}
          submitLabel="Создать приглашение" onCancel={() => setInviting(false)}
          onSubmit={async (v) => {
            const sharedItems = SHARED_ITEMS.map(([k]) => k).filter((k) => v[`item_${k}`]);
            const r = await employerApi.invite(projectId, { sharedItems, expiresAt: v.expiresAt ? String(v.expiresAt) : null });
            setInviting(false); setLink({ link: r.deepLink, expiresAt: r.expiresAt ?? '' }); refresh();
          }}
        />
      ) : <button type="button" className="secondary" onClick={() => setInviting(true)}>+ Пригласить агентство</button>)}
      {role === 'employer' && reports.data && reports.data.length > 0 && (
        <>
          <h3>Отчёты от агентства</h3>
          <ul>{reports.data.map((r: any) => <li key={r.id}><details><summary>{r.type ?? 'отчёт'} · {new Date(r.draftedAt ?? r.createdAt).toLocaleDateString('ru-RU')}</summary><JsonView data={r.content ?? r} /></details></li>)}</ul>
        </>
      )}
      {out && <div className="dtp-card"><div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div><div className="dtp-card__body">{out.data?.text ? <pre className="script-text">{out.data.text}</pre> : <JsonView data={out.data} />}</div></div>}
    </section>
  );
}
