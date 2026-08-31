'use client';

// Доменная вёрстка «Инвестиции» — предложение → встречи с разбором по
// критериям (общий ConsultationCard) → сверка с публичными источниками →
// матрица сравнения; группа совместных инвестиций — существующая панель.
import { useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { InvestmentGroupPanel } from '../DomainExtrasManual';
import { money } from '../dtp/dtp-types';
import { ComparisonMatrix, ConsultationCard, Consultation, CriteriaByCategory, Criterion, useList, useOne } from '../shared/ConsultationPipeline';

interface InvConfig { id: string; goalDescription: string; targetBudget: number | null; currency: string | null; criteria: Criterion[]; investmentGroupId?: string | null }
interface Opportunity { id: string; label: string; advisorName: string | null; advisorCompany: string | null }
interface SourceComparison { id: string; sourceUrl: string; sourceText: string; createdAt: string }
interface OpportunityDetail extends Opportunity { meetings: Consultation[]; comparisons: SourceComparison[] }

const CATEGORY_LABEL: Record<string, string> = { RETURN_GUARANTEE: 'Гарантии доходности', FEES_AND_LOSSES: 'Комиссии и возможные потери', TAXATION: 'Налоги', OTHER: 'Прочее' };
const REQUIRED_HINT = 'Гарантированная доходность — главный красный флаг: если советник обещает её, это должно быть видно в разборе и не подтверждаться источниками.';

function OpportunityCard({ o, cfg, spec }: { o: Opportunity; cfg: InvConfig; spec: any }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState<'meeting' | 'source' | null>(null);
  const { data, error } = useOne<OpportunityDetail>(open ? `/investment/opportunities/${o.id}` : null, tick);
  const bump = () => setTick((t) => t + 1);
  const sourceAction = spec.actions?.find((a: any) => a.key === 'source');
  const routes = { generate: (id: string) => `/investment/meetings/${id}/generate-breakdown`, review: (id: string) => `/investment/meetings/${id}/review` };
  return (
    <div className="dtp-card">
      <button type="button" className="dtp-card__head" onClick={() => setOpen(!open)}>
        <span><strong>{o.label}</strong>{(o.advisorName || o.advisorCompany) && <span className="dtp-muted"> · {[o.advisorName, o.advisorCompany].filter(Boolean).join(', ')}</span>}</span>
      </button>
      {open && (
        <div className="dtp-card__body">
          {error && <p className="generation-error">{error}</p>}
          <h4>Что говорил советник</h4>
          {data && data.meetings.length === 0 && <p className="dtp-muted">Встреч пока нет. Запишите разговор с советником — разбор покажет, что именно обещано по каждому критерию.</p>}
          {data?.meetings.map((m) => <ConsultationCard key={m.id} c={m} criteria={cfg.criteria} routes={routes} onChanged={bump} />)}
          {adding === 'meeting' ? <EntityForm fields={spec.sessions.fields} submitLabel="Добавить встречу" onCancel={() => setAdding(null)} onSubmit={async (v) => { await domainApi.postJson(spec.sessions.createRoute(o.id), v); setAdding(null); bump(); }} />
            : <button type="button" className="secondary" onClick={() => setAdding('meeting')}>+ Встреча</button>}
          <h4>Что говорят публичные источники</h4>
          <p className="dtp-hint">Проспект, сайт регулятора, независимый обзор — ссылка сохраняется с текстом на момент добавления. В сравнении будет видно, где слова советника расходятся с документами.</p>
          {data && data.comparisons.length === 0 && <p className="dtp-muted">Источников пока нет.</p>}
          <ul className="dtp-access-log">{data?.comparisons.map((c) => <li key={c.id}><a href={c.sourceUrl} target="_blank" rel="noreferrer">{c.sourceUrl}</a>{c.sourceText && <span className="dtp-muted"> — {c.sourceText.slice(0, 140)}{c.sourceText.length > 140 ? '…' : ''}</span>}</li>)}</ul>
          {sourceAction && (adding === 'source' ? <EntityForm fields={sourceAction.fields} submitLabel="Сверить с источником" onCancel={() => setAdding(null)} onSubmit={async (v) => { await domainApi.postJson(sourceAction.route(o.id), v); setAdding(null); bump(); }} />
            : <button type="button" className="secondary" onClick={() => setAdding('source')}>+ Источник</button>)}
        </div>
      )}
    </div>
  );
}

const TABS = [{ key: 'overview', label: 'Обзор' }, { key: 'opportunities', label: 'Предложения' }, { key: 'comparison', label: 'Сравнение' }, { key: 'group', label: 'Группа' }];

export function InvestmentWorkspace({ config, manifest, projectId }: { config: InvConfig; manifest: DomainManifest; projectId: string }) {
  const [tab, setTab] = useState('overview');
  const spec = manifest.entities.find((e) => e.key === 'opportunities')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error } = useList<Opportunity>(tab === 'opportunities' ? `/investment/configs/${config.id}/opportunities` : null, tick);
  return (
    <>
      <nav className="domain-tabs">{TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}</nav>
      {tab === 'overview' && (
        <section className="dtp-overview">
          <p className="dtp-status dtp-status--warn">Приложение не даёт инвестиционных советов и не оценивает доходность. Оно показывает, что обещал каждый советник по вашим критериям и что говорят публичные документы.</p>
          <div className="dtp-facts"><div><span className="dtp-facts__label">Сумма к размещению</span><strong>{money(config.targetBudget, config.currency)}</strong></div></div>
          <p className="dtp-goal">{config.goalDescription}</p>
          <h3>Критерии</h3>
          <CriteriaByCategory criteria={config.criteria} labels={CATEGORY_LABEL} />
          <p className="dtp-hint">{REQUIRED_HINT}</p>
        </section>
      )}
      {tab === 'opportunities' && (
        <section className="dtp-section">
          {error && <p className="generation-error">{error}</p>}
          {data && data.length === 0 && <p className="card-section__empty">Предложений пока нет.</p>}
          {data?.map((o) => <OpportunityCard key={o.id} o={o} cfg={config} spec={spec} />)}
          {adding ? <EntityForm fields={spec.fields} submitLabel="Добавить предложение" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(config.id), v); setAdding(false); setTick((t) => t + 1); }} />
            : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Предложение</button>}
        </section>
      )}
      {tab === 'comparison' && <ComparisonMatrix route={`/investment/configs/${config.id}/comparison-table`} sourceNoun="советников" />}
      {tab === 'group' && <InvestmentGroupPanel projectId={projectId} config={config} />}
    </>
  );
}
