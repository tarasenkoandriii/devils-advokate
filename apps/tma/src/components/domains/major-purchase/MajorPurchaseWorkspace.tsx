'use client';

// Доменная вёрстка «Крупная покупка» — другой конвейер (варианты →
// встречи → вывод), общий слой консультаций не применим, но стиль тот же:
// цена относительно бюджета, покрытие критериев да/частично/нет/не
// обсуждалось, сверка с объявлениями по ссылке.
import { useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { VariantLocationPanel } from '../DomainExtrasManual';
import { dateTime, money } from '../dtp/dtp-types';
import { useList, useOne } from '../shared/ConsultationPipeline';
import { haptic } from '../../../lib/telegram';

interface MpCriterion { id: string; text: string; isRequired: boolean }
interface MpConfig { id: string; category: 'REAL_ESTATE' | 'VEHICLE'; goalDescription: string; budgetMin: number | null; budgetMax: number | null; currency: string | null; financingMethod: string | null; timeline: string | null; criteria: MpCriterion[] }
interface Coverage { criterionId: string; covered: 'yes' | 'partial' | 'no' | 'unknown'; note: string }
interface Meeting { id: string; conversationId: string | null; occurredAt: string; conclusionDraft: string | null; draftedAt: string | null; conclusionFinal: string | null; reviewedAt: string | null; criteriaBreakdown: Coverage[] | null }
interface Comparison { id: string; sourceUrl: string; sourceText: string; extractedPrice: number | null; createdAt: string }
interface Variant { id: string; label: string; askingPrice: number | null; currency: string | null; placeName: string | null; placeAddress: string | null; latitude: number | null; longitude: number | null }
interface VariantDetail extends Variant { meetings: Meeting[]; comparisons: Comparison[] }
interface ComparisonTable { criteria: MpCriterion[]; variants: Array<Variant & { comparisonCount: number; latestConclusion: string | null; criteriaBreakdown: Coverage[] | null }> }

const COVER: Record<Coverage['covered'], { icon: string; label: string; cls: string }> = {
  yes: { icon: '✓', label: 'соответствует', cls: 'dtp-badge--ok' },
  partial: { icon: '◐', label: 'частично', cls: 'dtp-badge--warn' },
  no: { icon: '✕', label: 'не соответствует', cls: 'dtp-badge--bad' },
  unknown: { icon: '?', label: 'не обсуждалось', cls: 'dtp-badge--muted' },
};

function priceBadge(price: number | null, cfg: MpConfig) {
  if (price === null) return <span className="dtp-badge dtp-badge--muted">цена не указана</span>;
  if (cfg.budgetMax !== null && price > cfg.budgetMax) return <span className="dtp-badge dtp-badge--bad">выше бюджета на {money(price - cfg.budgetMax, cfg.currency)}</span>;
  if (cfg.budgetMin !== null && price < cfg.budgetMin) return <span className="dtp-badge dtp-badge--warn">ниже ожидаемого диапазона</span>;
  return <span className="dtp-badge dtp-badge--ok">в бюджете</span>;
}

function MeetingCard({ m, criteria, onChanged }: { m: Meeting; criteria: MpCriterion[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = m.reviewedAt ? 'reviewed' : m.conclusionDraft ? 'drafted' : 'new';
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return (
    <div className={`dtp-consultation dtp-consultation--${status}`}>
      <div className="dtp-consultation__head">
        <strong>{dateTime(m.occurredAt)}</strong>
        <span className={`dtp-badge ${status === 'reviewed' ? 'dtp-badge--ok' : status === 'drafted' ? 'dtp-badge--warn' : ''}`}>{status === 'reviewed' ? 'вывод подтверждён' : status === 'drafted' ? 'черновик вывода' : 'без вывода'}</span>
      </div>
      {!m.conversationId && status === 'new' && <p className="dtp-hint">Записи встречи нет — вывод формируется по записи и сверкам с объявлениями.</p>}
      {m.criteriaBreakdown && (
        <ul className="dtp-coverage">
          {m.criteriaBreakdown.map((c) => { const k = COVER[c.covered] ?? COVER.unknown; return <li key={c.criterionId}><span className={`dtp-badge ${k.cls}`}>{k.icon}</span> <strong>{byId.get(c.criterionId)?.text ?? c.criterionId}</strong>{c.note && <span className="dtp-muted"> — {c.note}</span>}</li>; })}
        </ul>
      )}
      {(m.conclusionFinal ?? m.conclusionDraft) && !editing && <pre className="dtp-protocol">{m.conclusionFinal ?? m.conclusionDraft}</pre>}
      {error && <p className="generation-error">{error}</p>}
      <div className="entity-form__actions">
        {m.conversationId && status !== 'reviewed' && <button type="button" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await domainApi.postJson(`/major-purchase/meetings/${m.id}/generate-conclusion`, {}); haptic('success'); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось'); } finally { setBusy(false); } }}>{busy ? '…' : status === 'drafted' ? 'Сформировать заново' : 'Сформировать вывод'}</button>}
        {status === 'drafted' && !editing && <button type="button" className="primary" onClick={() => setEditing(true)}>Поправить и подтвердить</button>}
      </div>
      {editing && (
        <EntityForm fields={[{ name: 'conclusionFinal', label: 'Итоговый вывод (правьте свободно — это ваш текст, не AI)', type: 'textarea', required: true }]} initial={{ conclusionFinal: m.conclusionDraft ?? '' }} submitLabel="Подтвердить вывод" onCancel={() => setEditing(false)}
          onSubmit={async (v) => { await domainApi.postJson(`/major-purchase/meetings/${m.id}/review-conclusion`, v); setEditing(false); onChanged(); }} />
      )}
    </div>
  );
}

function VariantCard({ v, cfg, spec }: { v: Variant; cfg: MpConfig; spec: any }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState<'meeting' | 'compare' | null>(null);
  const { data, error } = useOne<VariantDetail>(open ? `/major-purchase/variants/${v.id}` : null, tick);
  const bump = () => setTick((t) => t + 1);
  const compareAction = spec.actions?.find((a: any) => a.key === 'compare');
  const marketPrices = (data?.comparisons ?? []).map((c) => c.extractedPrice).filter((p): p is number => p !== null);
  const marketAvg = marketPrices.length ? marketPrices.reduce((a, b) => a + b, 0) / marketPrices.length : null;
  return (
    <div className="dtp-card">
      <button type="button" className="dtp-card__head" onClick={() => setOpen(!open)}>
        <span><strong>{v.label}</strong><br /><span className="dtp-muted">{money(v.askingPrice, v.currency ?? cfg.currency)}{v.placeName && ` · ${v.placeName}`}</span></span>
        {priceBadge(v.askingPrice, cfg)}
      </button>
      {open && (
        <div className="dtp-card__body">
          {error && <p className="generation-error">{error}</p>}
          {v.placeAddress && <p className="dtp-muted">📍 {v.placeAddress}</p>}
          <h4>Сверка с объявлениями</h4>
          {data && data.comparisons.length === 0 && <p className="dtp-muted">Нет. Добавьте ссылки на похожие объявления — цена из них попадёт в вывод и в сравнение.</p>}
          {marketAvg !== null && v.askingPrice !== null && <p className={v.askingPrice > marketAvg * 1.1 ? 'dtp-warn' : 'dtp-muted'}>Средняя по {marketPrices.length} объявлениям: {money(Math.round(marketAvg), v.currency ?? cfg.currency)} — запрашиваемая {v.askingPrice > marketAvg * 1.1 ? 'заметно выше' : v.askingPrice < marketAvg * 0.9 ? 'заметно ниже' : 'в рынке'}.</p>}
          <ul className="dtp-access-log">{data?.comparisons.map((c) => <li key={c.id}><a href={c.sourceUrl} target="_blank" rel="noreferrer">{c.sourceUrl}</a>{c.extractedPrice !== null && <span className="dtp-muted"> · {money(c.extractedPrice, v.currency ?? cfg.currency)}</span>}</li>)}</ul>
          {adding === 'compare' && compareAction ? <EntityForm fields={compareAction.fields} submitLabel="Сверить" onCancel={() => setAdding(null)} onSubmit={async (val) => { await domainApi.postJson(compareAction.route(v.id), val); setAdding(null); bump(); }} />
            : <button type="button" className="secondary" onClick={() => setAdding('compare')}>+ Объявление для сверки</button>}
          <h4>Встречи и осмотры</h4>
          {data && data.meetings.length === 0 && <p className="dtp-muted">Встреч пока нет.</p>}
          {data?.meetings.map((m) => <MeetingCard key={m.id} m={m} criteria={cfg.criteria} onChanged={bump} />)}
          {adding === 'meeting' ? <EntityForm fields={spec.sessions.fields} submitLabel="Добавить встречу" onCancel={() => setAdding(null)} onSubmit={async (val) => { await domainApi.postJson(spec.sessions.createRoute(v.id), val); setAdding(null); bump(); }} />
            : <button type="button" className="secondary" onClick={() => setAdding('meeting')}>+ Встреча</button>}
        </div>
      )}
    </div>
  );
}

function Variants({ cfg, manifest }: { cfg: MpConfig; manifest: DomainManifest }) {
  const spec = manifest.entities.find((e) => e.key === 'variants')!;
  const [tick, setTick] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error } = useList<Variant>(`/major-purchase/configs/${cfg.id}/variants`, tick);
  return (
    <section className="dtp-section">
      {error && <p className="generation-error">{error}</p>}
      {data && data.length === 0 && <p className="card-section__empty">Вариантов пока нет — добавьте квартиру/дом/машину, которые рассматриваете.</p>}
      {data?.map((v) => <VariantCard key={v.id} v={v} cfg={cfg} spec={spec} />)}
      {adding ? <EntityForm fields={spec.fields} initial={{ currency: cfg.currency ?? undefined }} submitLabel="Добавить вариант" onCancel={() => setAdding(false)} onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(cfg.id), v); setAdding(false); setTick((t) => t + 1); }} />
        : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Вариант</button>}
    </section>
  );
}

function Comparison({ cfg }: { cfg: MpConfig }) {
  const { data, error } = useOne<ComparisonTable>(`/major-purchase/configs/${cfg.id}/comparison-table`);
  if (error) return <p className="generation-error">{error}</p>;
  if (!data) return <p>Загрузка…</p>;
  if (data.variants.length === 0) return <p className="card-section__empty">Добавьте хотя бы один вариант.</p>;
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Покрытие критериев берётся из последнего вывода по варианту. «?» — тема не поднималась на встрече, это не минус варианту, а вопрос к следующей встрече.</p>
      <div className="domain-table-wrap">
        <table className="dtp-table dtp-table--matrix">
          <thead><tr><th></th>{data.variants.map((v) => <th key={v.id}>{v.label}</th>)}</tr></thead>
          <tbody>
            <tr><th>Цена</th>{data.variants.map((v) => <td key={v.id}>{money(v.askingPrice, v.currency ?? cfg.currency)}<br />{priceBadge(v.askingPrice, cfg)}</td>)}</tr>
            <tr><th>Сверок с объявлениями</th>{data.variants.map((v) => <td key={v.id}>{v.comparisonCount}</td>)}</tr>
            <tr><th>Локация</th>{data.variants.map((v) => <td key={v.id}>{v.placeName ?? (v.latitude !== null ? 'координаты' : <span className="dtp-muted">—</span>)}</td>)}</tr>
            {data.criteria.map((c) => (
              <tr key={c.id}>
                <th>{c.isRequired && <span className="dtp-badge dtp-badge--req">!</span>} {c.text}</th>
                {data.variants.map((v) => { const cov = v.criteriaBreakdown?.find((x) => x.criterionId === c.id); if (!v.criteriaBreakdown) return <td key={v.id}><span className="dtp-muted">нет вывода</span></td>; const k = COVER[cov?.covered ?? 'unknown']; return <td key={v.id}><span className={`dtp-badge ${k.cls}`} title={cov?.note}>{k.icon} {k.label}</span>{cov?.note && <div className="dtp-muted">{cov.note}</div>}</td>; })}
              </tr>
            ))}
            <tr><th>Последний вывод</th>{data.variants.map((v) => <td key={v.id}>{v.latestConclusion ? <span style={{ whiteSpace: 'pre-wrap' }}>{v.latestConclusion}</span> : <span className="dtp-muted">—</span>}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

const TABS = [{ key: 'overview', label: 'Обзор' }, { key: 'variants', label: 'Варианты' }, { key: 'comparison', label: 'Сравнение' }, { key: 'locations', label: 'Локации' }];

export function MajorPurchaseWorkspace({ config, manifest }: { config: MpConfig; manifest: DomainManifest }) {
  const [tab, setTab] = useState('overview');
  return (
    <>
      <nav className="domain-tabs">{TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}</nav>
      {tab === 'overview' && (
        <section className="dtp-overview">
          <div className="dtp-facts">
            <div><span className="dtp-facts__label">Что покупаем</span><strong>{config.category === 'REAL_ESTATE' ? 'Недвижимость' : 'Транспорт'}</strong></div>
            <div><span className="dtp-facts__label">Бюджет</span><strong>{config.budgetMin !== null || config.budgetMax !== null ? `${money(config.budgetMin, '')} – ${money(config.budgetMax, config.currency)}` : '—'}</strong></div>
            <div><span className="dtp-facts__label">Финансирование</span><strong>{config.financingMethod ?? '—'}</strong></div>
            <div><span className="dtp-facts__label">Сроки</span><strong>{config.timeline ?? '—'}</strong></div>
          </div>
          <p className="dtp-goal">{config.goalDescription}</p>
          <h3>Критерии</h3>
          <ul className="dtp-criteria-group">{config.criteria.map((c) => <li key={c.id}>{c.isRequired && <span className="dtp-badge dtp-badge--req">обязательно</span>} {c.text}</li>)}</ul>
          <p className="dtp-hint">Дальше: варианты → к каждому ссылки на похожие объявления и встречи → вывод по критериям → «Сравнение» покажет все варианты рядом. Приложение не выбирает за вас — оно показывает, где чего не хватает.</p>
        </section>
      )}
      {tab === 'variants' && <Variants cfg={config} manifest={manifest} />}
      {tab === 'comparison' && <Comparison cfg={config} />}
      {tab === 'locations' && <VariantLocationPanel configId={config.id} />}
    </>
  );
}
