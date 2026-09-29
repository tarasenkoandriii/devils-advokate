'use client';

// Пункт [job-domain-v2] §3.7–3.9 — «Компания»: одна модель досье на все три
// роли. Идентификация без сети (код / домен / название), подтверждение,
// факты только из открытых реестров с цитатой-подстрочкой (отзывы — только
// ссылка), представитель — заявление и проверка связи без сетевых вызовов,
// расхождения «бриф/вакансия/текст ↔ досье» двумя цитатами, история по
// компании. Приложение не выносит суждений о компании и не проверяет людей.
import { useEffect, useState } from 'react';
import { dossierApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { haptic } from '../../../lib/telegram';
import { SkippedNote } from '../../SkippedNotes';

const FACT_CATEGORY: Record<string, string> = { REGISTRY: 'реестр', COURT: 'суды', TAX: 'налоги', SANCTIONS: 'санкции', REVIEWS: 'отзывы (только ссылка)', DOMAIN: 'домен', OTHER: 'другое' };
const CHECK_LABEL: Record<string, string> = { CONFIRMED_PUBLIC: 'связь подтверждена открытыми данными', NOT_CONFIRMED: 'связь не подтверждена', AS_STATED: 'со слов' };

export function EmployerDossierPanel({ projectId, role, onChanged }: { projectId: string; role: 'candidate' | 'agency' | 'employer'; onChanged?: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [dossier, setDossier] = useState<any | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'identify' | 'source' | 'rep'>('none');
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    dossierApi.list(projectId).then((l) => { setList(l); if (l[0] && !dossier) dossierApi.get(l[0].id).then(setDossier).catch(setError); else if (dossier) dossierApi.get(dossier.id).then(setDossier).catch(setError); }).catch(setError);
  }, [projectId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(fn: () => Promise<T>, title?: string) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); if (title) setOut({ title, data: r }); setTick((t) => t + 1); onChanged?.(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const identifyForm = (
    <EntityForm
      fields={[
        { name: 'legalName', label: 'Название компании', type: 'text' },
        { name: 'registryCode', label: 'Код в реестре (ЕГРПОУ / ИНН…)', type: 'text' },
        { name: 'domain', label: 'Домен сайта', type: 'text', hint: 'Сайт компании автоматически не открывается — никаких запросов к нему' },
        { name: 'jurisdiction', label: 'Юрисдикция', type: 'text', hint: 'UA по умолчанию' },
      ]}
      submitLabel="Определить компанию" onCancel={() => setMode('none')}
      onSubmit={async (v) => { await dossierApi.identify(projectId, v as any); setMode('none'); setTick((t) => t + 1); onChanged?.(); }}
    />
  );

  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <p className="card-section__empty">
        {role === 'employer'
          ? 'Компания — реквизиты, которыми подписываются вакансия, уведомления кандидатам и оффер. Проект остаётся черновиком, пока компания не указана.'
          : role === 'agency'
            ? 'Заказчик как объект досье: реестры, представитель, расхождения между брифом и открытыми данными. Приложение собирает цитаты, не выносит вердикт о компании.'
            : 'Работодатель как объект досье: что о компании говорят открытые реестры, кто с вами общается и подтверждается ли его связь с компанией. Сайт компании автоматически не посещается, отзывы — только ссылками.'}
      </p>
      {list && list.length === 0 && mode !== 'identify' && (
        <>
          <p className="dtp-muted">Компания ещё не определена.</p>
          <button type="button" className="primary" onClick={() => setMode('identify')}>Указать компанию</button>
        </>
      )}
      {mode === 'identify' && identifyForm}
      {list && list.length > 1 && (
        <select value={dossier?.id ?? ''} onChange={(e) => dossierApi.get(e.target.value).then(setDossier).catch(setError)}>
          {list.map((d) => <option key={d.id} value={d.id}>{d.legalName ?? d.domain ?? d.registryCode ?? d.id}</option>)}
        </select>
      )}
      {dossier && (
        <>
          <div className="dtp-facts">
            <div><span className="dtp-facts__label">Название</span><strong>{dossier.legalName ?? '—'}</strong></div>
            <div><span className="dtp-facts__label">Код</span><strong>{dossier.registryCode ?? '—'}</strong></div>
            <div><span className="dtp-facts__label">Домен</span><strong>{dossier.domain ?? '—'}</strong></div>
            <div><span className="dtp-facts__label">Статус</span><strong>{dossier.confirmedAt ? 'подтверждена' : 'не подтверждена'} · {dossier.fresh ? 'данные свежие' : dossier.lastRefreshedAt ? 'данные устарели' : 'реестры не запрашивались'}</strong></div>
          </div>
          {dossier.registriesNote && <p className="dtp-status dtp-status--warn">{dossier.registriesNote}</p>}
          <div className="entity-form__actions">
            {!dossier.confirmedAt && <button type="button" className="primary" disabled={busy} onClick={() => run(() => dossierApi.confirm(dossier.id))}>Подтвердить: это та компания</button>}
            {dossier.registriesConnected && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => dossierApi.refresh(dossier.id), 'Обновление из реестров')}>Обновить из реестров</button>}
            <button type="button" className="secondary" onClick={() => setMode('source')}>+ Источник</button>
            <button type="button" className="secondary" onClick={() => setMode('rep')}>+ Представитель</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => run(() => dossierApi.discrepancies(dossier.id), 'Расхождения с досье')}>Расхождения</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => run(() => dossierApi.history(dossier.id), 'История по компании')}>История</button>
            {role !== 'candidate' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => dossierApi.candidateSummary(dossier.id), 'Выжимка о компании для кандидата')}>Выжимка для кандидата</button>}
            {role === 'agency' && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => dossierApi.shipmentChecklist(projectId), 'Чеклист перед отправкой заказчику')}>Чеклист отправки</button>}
            {list && list.length > 0 && <button type="button" className="secondary" onClick={() => setMode('identify')}>Другая компания</button>}
          </div>
          {mode === 'source' && (
            <EntityForm
              fields={[{ name: 'url', label: 'Ссылка на открытый источник', type: 'url', required: true }, { name: 'category', label: 'Категория', type: 'select', options: Object.entries(FACT_CATEGORY).map(([value, label]) => ({ value, label })) }]}
              submitLabel="Добавить" onCancel={() => setMode('none')}
              onSubmit={async (v) => { await dossierApi.addSource(dossier.id, v as any); setMode('none'); setTick((t) => t + 1); }}
            />
          )}
          {mode === 'rep' && (
            <EntityForm
              fields={[{ name: 'displayName', label: 'Имя, как представился', type: 'text', required: true }, { name: 'claimedRole', label: 'Роль со слов', type: 'text' }, { name: 'contactDomain', label: 'Домен почты, с которой пишет', type: 'text' }]}
              submitLabel="Записать заявление" onCancel={() => setMode('none')}
              onSubmit={async (v) => { await dossierApi.addRepresentative(dossier.id, v as any); setMode('none'); setTick((t) => t + 1); }}
            />
          )}
          <h3>Факты из открытых источников</h3>
          {dossier.facts.length === 0 && <p className="card-section__empty">Фактов пока нет.</p>}
          <ul>
            {dossier.facts.map((f: any) => (
              <li key={f.id}>
                <span className="domain-badge">{FACT_CATEGORY[f.category] ?? f.category}</span> {f.quote ? <>«{f.quote}»</> : <span className="dtp-muted">без цитаты</span>}
                {' '}<a href={f.sourceUrl} target="_blank" rel="noreferrer">источник</a>
                {f.fetchedAt && <span className="dtp-muted"> · {new Date(f.fetchedAt).toLocaleDateString('ru-RU')}</span>}
              </li>
            ))}
          </ul>
          <h3>Кто представляет компанию</h3>
          {dossier.representatives.length === 0 && <p className="card-section__empty">Представителей не записано.</p>}
          <ul>
            {dossier.representatives.map((r: any) => (
              <li key={r.id}>
                <strong>{r.displayName}</strong>{r.claimedRole ? ` · ${r.claimedRole}` : ''}{r.contactDomain ? ` · ${r.contactDomain}` : ''} — <span className="dtp-muted">{CHECK_LABEL[r.check] ?? r.check}</span>
                {' '}<button type="button" className="dtp-link" disabled={busy} onClick={() => run(() => dossierApi.checkRepresentative(r.id))}>проверить связь</button>
              </li>
            ))}
          </ul>
          <p className="dtp-hint">Проверка связи — только сопоставление домена и фактов реестра, без запросов в сеть и без «проверки человека». «Со слов» — нормальный статус, а не подозрение.</p>
        </>
      )}
      {out && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div>
          <div className="dtp-card__body">
            {/* [dropped-quotes] 2026-09-04: одна подпись на всю карточку —
                и под «Расхождений не найдено», и под отчётом обновления
                досье, где отброшенное за неточную цитату стало четвёртым
                названным видом отбрасывания рядом с тремя прежними. */}
            <SkippedNote skipped={out.data?.skippedWithoutQuote} />
            {Array.isArray(out.data?.discrepancies) ? (
              out.data.discrepancies.length === 0 ? <p className="card-section__empty">{out.data.reason ?? 'Расхождений между источниками и досье не найдено.'}</p> : (
                <ul>{out.data.discrepancies.map((d: any, i: number) => <li key={i}><strong>{d.topic}</strong>: досье — «{d.factQuote}» ↔ документ — «{d.documentQuote}»{d.note ? <span className="dtp-muted"> · {d.note}</span> : null}</li>)}</ul>
              )
            ) : out.data?.company ? (
              // А-28: выжимка, которую можно показать кандидату — только
              // проверяемые факты со ссылками, отзывы ссылками, без оценок.
              <>
                <p className="dtp-status dtp-status--warn">{out.data.frame}</p>
                <h4>{out.data.company.legalName ?? out.data.company.domain ?? 'Компания'}{out.data.company.registryCode ? ` · код ${out.data.company.registryCode}` : ''}</h4>
                {out.data.facts.length === 0 ? <p className="card-section__empty">Фактов с цитатами пока нет — показывать кандидату нечего.</p> : (
                  <ul>{out.data.facts.map((f: any, i: number) => <li key={i}>«{f.quote}» <a href={f.sourceUrl} target="_blank" rel="noreferrer">источник</a> <span className="dtp-muted">· {new Date(f.fetchedAt).toLocaleDateString('ru-RU')}</span></li>)}</ul>
                )}
                {out.data.reviewLinks.length > 0 && (
                  <>
                    <h4>Отзывы — ссылками</h4>
                    <ul>{out.data.reviewLinks.map((r: any, i: number) => <li key={i}><a href={r.url} target="_blank" rel="noreferrer">{r.url}</a></li>)}</ul>
                  </>
                )}
                {out.data.representatives.length > 0 && (
                  <>
                    <h4>Кто представляет компанию (связь подтверждена)</h4>
                    <ul>{out.data.representatives.map((r: any, i: number) => <li key={i}>{r.displayName}{r.claimedRole ? ` · ${r.claimedRole}` : ''}</li>)}</ul>
                  </>
                )}
                {out.data.gaps.length > 0 && <p className="dtp-muted">Чего не хватает: {out.data.gaps.join('; ')}.</p>}
                <p className="dtp-hint">{out.data.note}</p>
              </>
            ) : Array.isArray(out.data?.items) ? (
              <ul>{out.data.items.map((i: any) => <li key={i.key}>{i.ok ? '✓' : '○'} {i.label ?? i.key}{i.note ? <span className="dtp-muted"> · {i.note}</span> : null}</li>)}</ul>
            ) : <JsonView data={out.data} />}
          </div>
        </div>
      )}
    </section>
  );
}
