'use client';

// Доменная вёрстка «Семейное право» — по образцу ДТП, на общих компонентах
// shared/ConsultationPipeline (сравнение / сверка / бюджет / консультации).
import { useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { dateOnly, money } from '../dtp/dtp-types';
import { BudgetByCurrency, ComparisonMatrix, CriteriaByCategory, Criterion, CrossCheckList, SourceCard, TextDocument, useList } from '../shared/ConsultationPipeline';

interface FlConfig { id: string; goalDescription: string; targetBudget: number | null; currency: string | null; criteria: Criterion[]; project?: { contractType?: string } }
interface Party { id: string; role: 'SELF' | 'SPOUSE'; displayName: string | null }
interface Asset { id: string; assetType: string; description: string | null; ownerId: string | null; isMaritalProperty: boolean; estimatedValue: number | null; currency: string | null }
interface StatusDet { id: string; source: string; statusText: string; determinedAt: string; isOfficial: boolean; referenceDocumentNumber: string | null }
interface GoalRevision { id: string; goalDescription: string; changedAt: string }

const CATEGORY_LABEL: Record<string, string> = { ASSET_DIVISION: 'Раздел имущества', FINANCIAL_SUPPORT: 'Содержание', PROCESS_AND_COST: 'Процедура и стоимость', OTHER: 'Прочее' };
const BUDGET_LABEL: Record<string, string> = { ASSET_TRANSFER: 'Передача имущества', LEGAL_FEES: 'Юристы', SUPPORT_PAYMENT: 'Выплаты', OTHER: 'Прочее' };
const ROLE_LABEL: Record<string, string> = { SELF: 'Я', SPOUSE: 'Супруг(а)' };
const STATUS_SOURCE_LABEL: Record<string, string> = { COURT_FILING: 'Судебное дело', MEDIATION_AGREEMENT: 'Медиация', INFORMAL_AGREEMENT: 'Неформальная договорённость', UNDETERMINED: 'Не определено' };

function Parties({ configId, manifest }: { configId: string; manifest: DomainManifest }) {
  const spec = manifest.entities.find((e) => e.key === 'parties')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error } = useList<Party>(`/family-law/configs/${configId}/parties`, tick);
  return (
    <section className="dtp-section">
      {error && <p className="generation-error">{error}</p>}
      {data && !data.some((p) => p.role === 'SELF') && <p className="dtp-hint">Добавьте себя (роль «Я») и вторую сторону — без этого раздел имущества не к кому привязать.</p>}
      {data?.map((p) => (
        <div key={p.id} className="dtp-card"><div className="dtp-card__head dtp-card__head--static">
          <span><span className={`dtp-badge ${p.role === 'SELF' ? 'dtp-badge--role-self' : 'dtp-badge--role-other_party'}`}>{ROLE_LABEL[p.role] ?? p.role}</span> <strong>{p.displayName ?? 'без имени'}</strong></span>
        </div></div>
      ))}
      {adding ? <EntityForm fields={[{ name: 'role', label: 'Роль', type: 'select', required: true, options: [{ value: 'SELF', label: 'Я' }, { value: 'SPOUSE', label: 'Супруг(а)' }] }, { name: 'displayName', label: 'Имя', type: 'text' }]} submitLabel="Добавить сторону" onCancel={() => setAdding(false)}
        onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(configId), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Сторона</button>}
    </section>
  );
}

function Assets({ configId, manifest }: { configId: string; manifest: DomainManifest }) {
  const spec = manifest.entities.find((e) => e.key === 'assets')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error } = useList<Asset>(`/family-law/configs/${configId}/assets`, tick);
  const { data: parties } = useList<Party>(`/family-law/configs/${configId}/parties`);
  const partyName = (id: string | null) => { const p = parties?.find((x) => x.id === id); return p ? `${ROLE_LABEL[p.role] ?? p.role}${p.displayName ? ` (${p.displayName})` : ''}` : 'не указан'; };
  const totals = new Map<string, { marital: number; personal: number }>();
  for (const a of data ?? []) { if (a.estimatedValue === null) continue; const k = a.currency ?? '—'; const t = totals.get(k) ?? { marital: 0, personal: 0 }; if (a.isMaritalProperty) t.marital += a.estimatedValue; else t.personal += a.estimatedValue; totals.set(k, t); }
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Совместно нажитое делится по умолчанию, личное — нет. Пометка «совместно нажитое» — ваша, юрист может с ней не согласиться: это и будет видно в сверке.</p>
      {error && <p className="generation-error">{error}</p>}
      {totals.size > 0 && <div className="domain-budget__summary">{[...totals.entries()].map(([cur, t]) => <div key={cur} className="domain-budget__currency"><strong>{cur}</strong><span>совместное {money(t.marital)}</span><span>личное {money(t.personal)}</span></div>)}</div>}
      {data?.map((a) => (
        <div key={a.id} className="dtp-card"><div className="dtp-card__head dtp-card__head--static">
          <span><strong>{a.assetType}</strong>{a.description && <span className="dtp-muted"> · {a.description}</span>}<br /><span className="dtp-muted">владелец: {partyName(a.ownerId)} · {money(a.estimatedValue, a.currency)}</span></span>
          <span className={a.isMaritalProperty ? 'dtp-badge dtp-badge--warn' : 'dtp-badge'}>{a.isMaritalProperty ? 'совместное' : 'личное'}</span>
        </div></div>
      ))}
      {adding ? <EntityForm fields={[...spec.fields, { name: 'ownerId', label: 'Владелец', type: 'select', options: (parties ?? []).map((p) => ({ value: p.id, label: `${ROLE_LABEL[p.role] ?? p.role}${p.displayName ? ` (${p.displayName})` : ''}` })) }]} submitLabel="Добавить актив" onCancel={() => setAdding(false)}
        onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(configId), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Актив</button>}
    </section>
  );
}

function Statuses({ configId, manifest }: { configId: string; manifest: DomainManifest }) {
  const spec = manifest.entities.find((e) => e.key === 'status')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error } = useList<StatusDet>(`/family-law/configs/${configId}/status-determinations`, tick);
  const sorted = [...(data ?? [])].sort((a, b) => +new Date(b.determinedAt) - +new Date(a.determinedAt));
  const official = sorted.find((d) => d.isOfficial);
  return (
    <section className="dtp-section">
      {error && <p className="generation-error">{error}</p>}
      {official ? <p className="dtp-status dtp-status--ok">Официально: <strong>{official.statusText}</strong> · {STATUS_SOURCE_LABEL[official.source] ?? official.source} · {dateOnly(official.determinedAt)}</p> : <p className="dtp-status dtp-status--warn">Официального статуса (решение суда, нотариальное удостоверение) пока нет — всё ниже мнения и договорённости.</p>}
      <ol className="dtp-timeline">{sorted.map((d) => <li key={d.id} className={d.isOfficial ? 'dtp-timeline__item dtp-timeline__item--official' : 'dtp-timeline__item'}><time>{dateOnly(d.determinedAt)}</time><div><strong>{d.statusText}</strong><br /><span className="dtp-muted">{STATUS_SOURCE_LABEL[d.source] ?? d.source}{d.isOfficial ? ' · официально' : ' · мнение'}{d.referenceDocumentNumber && ` · № ${d.referenceDocumentNumber}`}</span></div></li>)}</ol>
      {adding ? <EntityForm fields={spec.fields} submitLabel="Добавить запись" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(configId), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Статус</button>}
    </section>
  );
}

function Goal({ config, onUpdated }: { config: FlConfig; onUpdated: (c: any) => void }) {
  const [tick, setTick] = useState(0);
  const { data } = useList<GoalRevision>(`/family-law/configs/${config.id}/goal-history`, tick);
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Цель меняется по ходу переговоров — это нормально. История нужна, чтобы видеть, от чего вы отступили и почему.</p>
      <EntityForm fields={[{ name: 'goalDescription', label: 'Цель', type: 'textarea', required: true }]} initial={{ goalDescription: config.goalDescription }} submitLabel="Сохранить цель"
        onSubmit={async (v) => { const u = await domainApi.patchJson(`/family-law/configs/${config.id}/goal`, v); onUpdated({ ...config, ...u }); setTick((t) => t + 1); }} />
      {data && data.length > 0 && <ol className="dtp-timeline">{[...data].reverse().map((r) => <li key={r.id} className="dtp-timeline__item"><time>{dateOnly(r.changedAt)}</time><div>{r.goalDescription}</div></li>)}</ol>}
    </section>
  );
}

const TABS = [
  { key: 'overview', label: 'Обзор' }, { key: 'parties', label: 'Стороны' }, { key: 'assets', label: 'Имущество' }, { key: 'advisors', label: 'Юристы' },
  { key: 'comparison', label: 'Сравнение' }, { key: 'cross', label: 'Сверка' }, { key: 'budget', label: 'Бюджет' }, { key: 'protocol', label: 'Соглашение' }, { key: 'status', label: 'Статус' }, { key: 'goal', label: 'Цель' },
];

export function FamilyLawWorkspace({ config, manifest, onConfigUpdated }: { config: FlConfig; manifest: DomainManifest; onConfigUpdated: (c: any) => void }) {
  const [tab, setTab] = useState('overview');
  const advisorsSpec = manifest.entities.find((e) => e.key === 'advisors')!;
  const budgetSpec = manifest.extras.find((x) => x.key === 'budget')!;
  const [advTick, setAdvTick] = useState(0); const [addingAdv, setAddingAdv] = useState(false);
  const { data: advisors, error: advError } = useList<{ id: string; label: string; advisorName: string | null; role: string | null }>(tab === 'advisors' ? `/family-law/configs/${config.id}/advisors` : null, advTick);
  const routes = { generate: (id: string) => `/family-law/consultations/${id}/generate-breakdown`, review: (id: string) => `/family-law/consultations/${id}/review` };
  return (
    <>
      <nav className="domain-tabs">{TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}</nav>
      {tab === 'overview' && (
        <section className="dtp-overview">
          <div className="dtp-facts">
            <div><span className="dtp-facts__label">Тип</span><strong>{config.project?.contractType === 'PRENUP' ? 'Брачный договор' : config.project?.contractType === 'DIVORCE_SETTLEMENT' ? 'Соглашение при разводе' : '—'}</strong></div>
            <div><span className="dtp-facts__label">Целевой бюджет</span><strong>{money(config.targetBudget, config.currency)}</strong></div>
          </div>
          <p className="dtp-goal">{config.goalDescription}</p>
          <h3>Критерии — что нужно выяснить</h3>
          <CriteriaByCategory criteria={config.criteria} labels={CATEGORY_LABEL} />
          <p className="dtp-hint">Дальше: стороны и имущество, затем консультации юристов — по каждой AI разложит сказанное по критериям, «Сверка» покажет, где юристы расходятся. Уведомление о медиации — внутри консультации.</p>
        </section>
      )}
      {tab === 'parties' && <Parties configId={config.id} manifest={manifest} />}
      {tab === 'assets' && <Assets configId={config.id} manifest={manifest} />}
      {tab === 'advisors' && (
        <section className="dtp-section">
          {advError && <p className="generation-error">{advError}</p>}
          {advisors && advisors.length === 0 && <p className="card-section__empty">Юристов пока нет.</p>}
          {advisors?.map((a) => (
            <SourceCard key={a.id} source={a} subtitle={a.advisorName} badge={a.role} criteria={config.criteria} spec={advisorsSpec} routes={routes}>
              {() => <details style={{ width: '100%' }}><summary className="dtp-muted">Уведомление о медиации (§ обязательное предложение)</summary><MediationNoticeFor advisorId={a.id} /></details>}
            </SourceCard>
          ))}
          {addingAdv ? <EntityForm fields={advisorsSpec.fields} submitLabel="Добавить юриста" onCancel={() => setAddingAdv(false)} onSubmit={async (v) => { await domainApi.postJson(advisorsSpec.createRoute(config.id), v); setAddingAdv(false); setAdvTick((t) => t + 1); }} />
            : <button type="button" className="primary" onClick={() => setAddingAdv(true)}>+ Юрист</button>}
        </section>
      )}
      {tab === 'comparison' && <ComparisonMatrix route={`/family-law/configs/${config.id}/comparison-table`} sourceNoun="юристов" />}
      {tab === 'cross' && <CrossCheckList route={`/family-law/configs/${config.id}/cross-consultation-check`} criteria={config.criteria} sourceNoun="юристами" />}
      {tab === 'budget' && <BudgetByCurrency route={budgetSpec.route(config.id)} createRoute={budgetSpec.budgetCreateRoute!(config.id)} fields={budgetSpec.budgetFields!} categoryLabels={BUDGET_LABEL} />}
      {tab === 'protocol' && <TextDocument route={`/family-law/configs/${config.id}/settlement-protocol-draft`} share />}
      {tab === 'status' && <Statuses configId={config.id} manifest={manifest} />}
      {tab === 'goal' && <Goal config={config} onUpdated={onConfigUpdated} />}
    </>
  );
}

function MediationNoticeFor({ advisorId }: { advisorId: string }) {
  // Уведомление одинаково для всех консультаций (константа на backend) —
  // берём по первой консультации юриста, чтобы не дублировать по каждой.
  const { data } = useList<{ id: string }>(`/family-law/advisors/${advisorId}/consultations`);
  if (!data) return <p className="dtp-muted">Загрузка…</p>;
  if (data.length === 0) return <p className="dtp-muted">Появится после первой консультации.</p>;
  return <TextDocument route={`/family-law/consultations/${data[0].id}/mediation-notice`} />;
}
