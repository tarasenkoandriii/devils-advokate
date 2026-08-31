'use client';

// Доменная вёрстка «Здоровье» — по образцу ДТП, на общих компонентах.
// Особенности: врачи вместо консультантов, источники (ссылки) у каждого
// врача, анализы = OCR-черновик, который пользователь подтверждает.
import { useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { dateTime, money } from '../dtp/dtp-types';
import { haptic } from '../../../lib/telegram';
import { BudgetByCurrency, ComparisonMatrix, CriteriaByCategory, Criterion, SourceCard, useList } from '../shared/ConsultationPipeline';

interface HealthConfig { id: string; goalDescription: string; targetBudget: number | null; currency: string | null; criteria: Criterion[] }
interface Provider { id: string; label: string; providerName: string | null; specialty: string | null }
interface SourceRef { id: string; sourceUrl: string; sourceText: string | null; createdAt: string }
interface LabDoc { id: string; ocrText: string; verified: boolean; verifiedAt: string | null; createdAt: string }

const CATEGORY_LABEL: Record<string, string> = { PROCEDURE_NECESSITY: 'Нужна ли процедура', RISKS_AND_ALTERNATIVES: 'Риски и альтернативы', COST: 'Стоимость', OTHER: 'Прочее' };
const BUDGET_LABEL: Record<string, string> = { PROCEDURE_COST: 'Процедуры', MEDICATION: 'Лекарства', INSURANCE_COVERAGE: 'Страховое покрытие', OTHER: 'Прочее' };

function SourceRefs({ providerId, spec }: { providerId: string; spec: any }) {
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data } = useList<SourceRef>(`/health/providers/${providerId}/source-references`, tick);
  const action = spec.actions?.find((a: any) => a.key === 'source');
  return (
    <div style={{ width: '100%' }}>
      <h4>Источники, на которые ссылался врач</h4>
      {data && data.length === 0 && <p className="dtp-muted">Нет. Если врач ссылался на исследование или протокол — добавьте ссылку, она попадёт в сравнение.</p>}
      <ul className="dtp-access-log">{data?.map((r) => <li key={r.id}><a href={r.sourceUrl} target="_blank" rel="noreferrer">{r.sourceUrl}</a>{r.sourceText && <span className="dtp-muted"> — {r.sourceText.slice(0, 120)}{r.sourceText.length > 120 ? '…' : ''}</span>}</li>)}</ul>
      {action && (adding ? <EntityForm fields={action.fields} submitLabel="Добавить источник" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(action.route(providerId), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="secondary" onClick={() => setAdding(true)}>+ Источник</button>)}
    </div>
  );
}

function LabDocuments({ configId, manifest }: { configId: string; manifest: DomainManifest }) {
  const spec = manifest.entities.find((e) => e.key === 'labs')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false); const [busyId, setBusyId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const { data, error: loadError } = useList<LabDoc>(`/health/configs/${configId}/lab-documents`, tick);
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Скан или фото анализа распознаётся (OCR) в текст-черновик. Пока вы не подтвердили, что текст совпадает с документом, он нигде не используется как факт — сверьте цифры сами.</p>
      {(error || loadError) && <p className="generation-error">{error ?? loadError}</p>}
      {data && data.length === 0 && <p className="card-section__empty">Анализов пока нет.</p>}
      {data?.map((d) => (
        <div key={d.id} className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>Документ от {dateTime(d.createdAt)}</span><span className={d.verified ? 'dtp-badge dtp-badge--ok' : 'dtp-badge dtp-badge--warn'}>{d.verified ? 'подтверждён' : 'черновик OCR'}</span></div>
          <div className="dtp-card__body">
            <pre className="dtp-protocol" style={{ maxHeight: 220, overflow: 'auto' }}>{d.ocrText || '(текст не распознан)'}</pre>
            {!d.verified && <button type="button" className="primary" disabled={busyId === d.id} onClick={async () => { setBusyId(d.id); setError(null); try { await domainApi.postJson(`/health/lab-documents/${d.id}/verify`, {}); haptic('success'); setTick((t) => t + 1); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подтвердить'); } finally { setBusyId(null); } }}>Текст совпадает с документом</button>}
          </div>
        </div>
      ))}
      {adding ? <EntityForm fields={spec.fields} submitLabel="Загрузить и распознать" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(configId), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Анализ (фото/скан)</button>}
    </section>
  );
}

const TABS = [
  { key: 'overview', label: 'Обзор' }, { key: 'providers', label: 'Врачи' }, { key: 'labs', label: 'Анализы' },
  { key: 'comparison', label: 'Сравнение' }, { key: 'budget', label: 'Бюджет' },
];

export function HealthWorkspace({ config, manifest }: { config: HealthConfig; manifest: DomainManifest }) {
  const [tab, setTab] = useState('overview');
  const spec = manifest.entities.find((e) => e.key === 'providers')!;
  const budgetSpec = manifest.extras.find((x) => x.key === 'budget')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data: providers, error } = useList<Provider>(tab === 'providers' ? `/health/configs/${config.id}/providers` : null, tick);
  const routes = { generate: (id: string) => `/health/consultations/${id}/generate-breakdown`, review: (id: string) => `/health/consultations/${id}/review` };
  return (
    <>
      <nav className="domain-tabs">{TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}</nav>
      {tab === 'overview' && (
        <section className="dtp-overview">
          <p className="dtp-status dtp-status--warn">Приложение не ставит диагнозов и не выбирает лечение. Оно показывает, что сказал каждый врач по вашим вопросам, и где они расходятся — решение остаётся за вами и вашим врачом.</p>
          <div className="dtp-facts"><div><span className="dtp-facts__label">Целевой бюджет</span><strong>{money(config.targetBudget, config.currency)}</strong></div></div>
          <p className="dtp-goal">{config.goalDescription}</p>
          <h3>Вопросы, на которые нужны ответы</h3>
          <CriteriaByCategory criteria={config.criteria} labels={CATEGORY_LABEL} />
        </section>
      )}
      {tab === 'providers' && (
        <section className="dtp-section">
          <p className="dtp-hint">Каждый врач — отдельно. После консультации добавьте запись и разбор: AI разложит сказанное по вашим вопросам. Ссылки на исследования, которые врач упоминал, — в карточке врача.</p>
          {error && <p className="generation-error">{error}</p>}
          {providers && providers.length === 0 && <p className="card-section__empty">Врачей пока нет.</p>}
          {providers?.map((p) => (
            <SourceCard key={p.id} source={p} subtitle={p.providerName} badge={p.specialty} criteria={config.criteria} spec={spec} routes={routes}>
              {() => <SourceRefs providerId={p.id} spec={spec} />}
            </SourceCard>
          ))}
          {adding ? <EntityForm fields={spec.fields} submitLabel="Добавить врача" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(config.id), v); setAdding(false); setTick((t) => t + 1); }} />
            : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Врач</button>}
        </section>
      )}
      {tab === 'labs' && <LabDocuments configId={config.id} manifest={manifest} />}
      {tab === 'comparison' && <ComparisonMatrix route={`/health/configs/${config.id}/comparison-table`} sourceNoun="врачей" />}
      {tab === 'budget' && <BudgetByCurrency route={budgetSpec.route(config.id)} createRoute={budgetSpec.budgetCreateRoute!(config.id)} fields={budgetSpec.budgetFields!} categoryLabels={BUDGET_LABEL} />}
    </>
  );
}
