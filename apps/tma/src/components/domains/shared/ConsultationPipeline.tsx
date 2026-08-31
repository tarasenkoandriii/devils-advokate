'use client';

// Общие доменные компоненты для конвейера «консультанты → консультации →
// разбор по критериям» (dtp / family-law / health используют один
// CriteriaComparisonService и одинаковую форму budget). Вынесены из
// образца ДТП (ТЗ §5, шаг 2). Домен передаёт только пути и словари.
import { useEffect, useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { EntitySpec, FieldSpec } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { haptic, shareViaTelegram } from '../../../lib/telegram';
import { CROSS_LABEL, CrossConsultationStatus, dateTime, money } from '../dtp/dtp-types';

export interface Criterion { id: string; text: string; category: string; isRequired: boolean }
export interface Statement { criterionId: string; whatWasSaid: string }
export interface Consultation { id: string; conversationId: string | null; occurredAt: string; criteriaBreakdown: Statement[] | null; reviewedAt: string | null; reviewNotes: string | null; estimatedCost?: number | null; currency?: string | null }
export interface ComparisonSource { id: string; label: string; consultationsCount?: number; meetingsCount?: number; latestBreakdown: Statement[] | null; sourceReferenceCount?: number; comparisonCount?: number }
export interface ComparisonTable { criteria: Criterion[]; advisors?: ComparisonSource[]; providers?: ComparisonSource[]; opportunities?: ComparisonSource[]; budget?: { targetBudget: number | null; currency: string | null; totalEstimatedCost: number } }
export interface CrossCheckRow { criterionId: string; status: CrossConsultationStatus; statements: Array<{ sourceLabel: string; whatWasSaid: string }>; discrepancyNote?: string }
export interface BudgetLine { id: string; category: string; direction: 'EXPENSE' | 'COVERAGE'; amount: number; currency: string | null; description: string | null }
export interface Budget { lineItems: BudgetLine[]; byCurrency: Array<{ currency: string; totalExpense: number; totalCoverage: number; netBudget: number }>; targetBudget: number | null; currency: string | null; hasLegacyEstimatedCosts: boolean }

export function useList<T>(route: string | null, tick: unknown = 0) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!route) return;
    setError(null);
    domainApi.getJson(route).then((d) => setData(Array.isArray(d) ? d : [])).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [route, tick]);
  return { data, error };
}

export function useOne<T>(route: string | null, tick: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!route) return;
    setError(null);
    domainApi.getJson(route).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [route, tick]);
  return { data, error };
}

// ── Критерии по категориям (обзор) ──

export function CriteriaByCategory({ criteria, labels }: { criteria: Criterion[]; labels: Record<string, string> }) {
  const grouped = new Map<string, Criterion[]>();
  for (const c of criteria ?? []) grouped.set(c.category, [...(grouped.get(c.category) ?? []), c]);
  if (grouped.size === 0) return <p className="card-section__empty">Критериев нет — они появляются из онбординга.</p>;
  return (
    <>
      {[...grouped.entries()].map(([cat, items]) => (
        <div key={cat} className="dtp-criteria-group">
          <h4>{labels[cat] ?? cat}</h4>
          <ul>{items.map((c) => <li key={c.id}>{c.isRequired && <span className="dtp-badge dtp-badge--req">обязательно</span>} {c.text}</li>)}</ul>
        </div>
      ))}
    </>
  );
}

// ── Консультация с разбором ──

export function ConsultationCard({ c, criteria, routes, onChanged, reviewFields, extraHint }: {
  c: Consultation; criteria: Criterion[];
  routes: { generate: (id: string) => string; review: (id: string) => string };
  onChanged: () => void; reviewFields?: FieldSpec[]; extraHint?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = c.reviewedAt ? 'reviewed' : c.criteriaBreakdown ? 'drafted' : 'new';
  const byId = new Map(criteria.map((k) => [k.id, k]));
  async function generate() {
    setBusy(true); setError(null);
    try { await domainApi.postJson(routes.generate(c.id), {}); haptic('success'); onChanged(); }
    catch (e) { haptic('error'); setError(e instanceof Error ? e.message : 'Не удалось разобрать'); }
    finally { setBusy(false); }
  }
  return (
    <div className={`dtp-consultation dtp-consultation--${status}`}>
      <div className="dtp-consultation__head">
        <div><strong>{dateTime(c.occurredAt)}</strong>{c.estimatedCost != null && <span className="dtp-muted"> · оценка {money(c.estimatedCost, c.currency)}</span>}</div>
        <span className={`dtp-badge ${status === 'reviewed' ? 'dtp-badge--ok' : status === 'drafted' ? 'dtp-badge--warn' : ''}`}>{status === 'reviewed' ? 'проверена' : status === 'drafted' ? 'черновик разбора' : 'без разбора'}</span>
      </div>
      {!c.conversationId && status === 'new' && <p className="dtp-hint">Записи разговора нет — разбор возможен только по записи. Загрузите аудио в «Разговорах» проекта и укажите ID при создании.</p>}
      {c.criteriaBreakdown && (
        <table className="dtp-table"><tbody>
          {c.criteriaBreakdown.map((s, i) => <tr key={i}><th>{byId.get(s.criterionId)?.text ?? s.criterionId}</th><td>{s.whatWasSaid || <span className="dtp-muted">не затрагивалось</span>}</td></tr>)}
        </tbody></table>
      )}
      {c.reviewNotes && <p className="dtp-notes">Заметки: {c.reviewNotes}</p>}
      {extraHint}
      {error && <p className="generation-error">{error}</p>}
      <div className="entity-form__actions">
        {c.conversationId && status !== 'reviewed' && <button type="button" className="secondary" disabled={busy} onClick={generate}>{busy ? '…' : status === 'drafted' ? 'Разобрать заново' : 'Разобрать по критериям'}</button>}
        {status === 'drafted' && !reviewing && <button type="button" className="primary" onClick={() => setReviewing(true)}>Проверил(а), подтвердить</button>}
      </div>
      {reviewing && (
        <EntityForm fields={reviewFields ?? [{ name: 'reviewNotes', label: 'Что уточнить или поправить (необязательно)', type: 'textarea' }]} submitLabel="Подтвердить разбор" onCancel={() => setReviewing(false)}
          onSubmit={async (v) => { await domainApi.postJson(routes.review(c.id), v); setReviewing(false); onChanged(); }} />
      )}
    </div>
  );
}

// ── Источник (консультант / врач) с консультациями ──

export function SourceCard({ source, subtitle, badge, criteria, spec, routes, children }: {
  source: { id: string; label: string }; subtitle?: string | null; badge?: string | null;
  criteria: Criterion[]; spec: EntitySpec;
  routes: { generate: (id: string) => string; review: (id: string) => string };
  children?: (ctx: { tick: number; bump: () => void }) => React.ReactNode;
}) {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, error } = useList<Consultation>(open ? spec.sessions!.listRoute(source.id) : null, tick);
  const bump = () => setTick((t) => t + 1);
  return (
    <div className="dtp-card">
      <button type="button" className="dtp-card__head" onClick={() => setOpen(!open)}>
        <span><strong>{source.label}</strong>{subtitle && <span className="dtp-muted"> · {subtitle}</span>}</span>
        {badge && <span className="dtp-badge">{badge}</span>}
      </button>
      {open && (
        <div className="dtp-card__body">
          {error && <p className="generation-error">{error}</p>}
          {data && data.length === 0 && <p className="card-section__empty">Консультаций пока нет.</p>}
          {data?.map((c) => <ConsultationCard key={c.id} c={c} criteria={criteria} routes={routes} onChanged={bump} reviewFields={spec.sessions!.reviewFields} />)}
          {adding ? (
            <EntityForm fields={spec.sessions!.fields} submitLabel={`Добавить · ${spec.sessions!.singular}`} onCancel={() => setAdding(false)}
              onSubmit={async (v) => { await domainApi.postJson(spec.sessions!.createRoute(source.id), v); setAdding(false); bump(); }} />
          ) : <button type="button" className="secondary" onClick={() => setAdding(true)}>+ {spec.sessions!.singular}</button>}
          {children?.({ tick, bump })}
        </div>
      )}
    </div>
  );
}

// ── Сравнение ──

export function ComparisonMatrix({ route, sourceNoun }: { route: string; sourceNoun: string }) {
  const { data, error } = useOne<ComparisonTable>(route);
  if (error) return <p className="generation-error">{error}</p>;
  if (!data) return <p>Загрузка…</p>;
  const sources = (data.advisors ?? data.providers ?? data.opportunities ?? []).filter((a) => a.latestBreakdown);
  if (sources.length === 0) return <p className="card-section__empty">Сравнивать пока нечего — нужна хотя бы одна консультация с разбором по критериям.</p>;
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Таблица не выбирает «лучшего» — она кладёт сказанное каждым рядом. Пустая ячейка значит «не затрагивалось», а не «неправ».</p>
      <div className="domain-table-wrap">
        <table className="dtp-table dtp-table--matrix">
          <thead><tr><th>Критерий</th>{sources.map((a) => <th key={a.id}>{a.label}<br /><span className="dtp-muted">{a.consultationsCount ?? a.meetingsCount ?? 0} встр.{a.sourceReferenceCount || a.comparisonCount ? ` · ${a.sourceReferenceCount ?? a.comparisonCount} ист.` : ''}</span></th>)}</tr></thead>
          <tbody>
            {data.criteria.map((c) => (
              <tr key={c.id}>
                <th>{c.isRequired && <span className="dtp-badge dtp-badge--req">!</span>} {c.text}</th>
                {sources.map((a) => { const s = a.latestBreakdown!.find((x) => x.criterionId === c.id); return <td key={a.id}>{s?.whatWasSaid || <span className="dtp-muted">—</span>}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.budget && <p className="dtp-muted">Сумма оценок {sourceNoun}: {money(data.budget.totalEstimatedCost, data.budget.currency)}{data.budget.targetBudget !== null && ` при целевом бюджете ${money(data.budget.targetBudget, data.budget.currency)}`}</p>}
    </section>
  );
}

// ── Сверка ──

export function CrossCheckList({ route, criteria, sourceNoun }: { route: string; criteria: Criterion[]; sourceNoun: string }) {
  const { data: rows, error } = useOne<CrossCheckRow[]>(route);
  if (error) return <p className="generation-error">{error}</p>;
  if (!rows) return <p>Загрузка…</p>;
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const found = rows.filter((r) => r.status === 'DISCREPANCY_FOUND');
  return (
    <section className="dtp-section">
      <p className={found.length ? 'dtp-status dtp-status--warn' : 'dtp-status dtp-status--ok'}>{found.length ? `Расхождения по ${found.length} из ${rows.length} критериев — именно их стоит уточнить у ${sourceNoun}.` : `Явных расхождений между ${sourceNoun} нет.`}</p>
      {rows.map((r) => {
        const lbl = CROSS_LABEL[r.status];
        return (
          <div key={r.criterionId} className="dtp-card">
            <div className="dtp-card__head dtp-card__head--static"><strong>{byId.get(r.criterionId)?.text ?? r.criterionId}</strong><span className={`dtp-badge dtp-badge--${lbl.tone}`}>{lbl.text}</span></div>
            {(r.statements.length > 0 || r.discrepancyNote) && (
              <div className="dtp-card__body">
                {r.discrepancyNote && <p className="dtp-warn">{r.discrepancyNote}</p>}
                {r.statements.map((s, i) => <p key={i}><strong>{s.sourceLabel}:</strong> {s.whatWasSaid}</p>)}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

// ── Бюджет по валютам ──

export function BudgetByCurrency({ route, createRoute, fields, categoryLabels }: { route: string; createRoute: string; fields: FieldSpec[]; categoryLabels: Record<string, string> }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error } = useOne<Budget>(route, tick);
  if (error) return <p className="generation-error">{error}</p>;
  if (!data) return <p>Загрузка…</p>;
  const expenses = data.lineItems.filter((l) => l.direction === 'EXPENSE');
  const coverage = data.lineItems.filter((l) => l.direction === 'COVERAGE');
  return (
    <section className="dtp-section">
      <div className="domain-budget__summary">
        {data.byCurrency.map((b) => {
          const over = data.targetBudget !== null && b.currency === (data.currency ?? b.currency) && b.netBudget > data.targetBudget;
          return (
            <div key={b.currency} className={over ? 'domain-budget__currency dtp-budget--over' : 'domain-budget__currency'}>
              <strong>{b.currency}</strong>
              <span>расходы {money(b.totalExpense)}</span>
              <span>покрытие {money(b.totalCoverage)}</span>
              <span>из своего кармана <strong>{money(b.netBudget)}</strong></span>
              {over && <span className="dtp-warn">выше целевого бюджета {money(data.targetBudget)}</span>}
            </div>
          );
        })}
        {data.byCurrency.length === 0 && <p className="card-section__empty">Строк пока нет.</p>}
      </div>
      {data.hasLegacyEstimatedCosts && <p className="dtp-hint">У части консультаций есть «ориентировочная стоимость» — она не входит в строки бюджета, добавьте её явно, если она реальна.</p>}
      {[['Расходы', expenses], ['Покрытие (страховка, возмещение)', coverage]].map(([title, list]) => (list as BudgetLine[]).length > 0 && (
        <div key={String(title)} style={{ width: '100%' }}>
          <h4>{String(title)}</h4>
          <table className="dtp-table"><tbody>{(list as BudgetLine[]).map((l) => <tr key={l.id}><th>{categoryLabels[l.category] ?? l.category}</th><td>{l.description ?? ''}</td><td className="dtp-num">{money(l.amount, l.currency)}</td></tr>)}</tbody></table>
        </div>
      ))}
      {adding ? (
        <EntityForm fields={fields} initial={{ currency: data.currency ?? undefined }} submitLabel="Добавить строку" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(createRoute, v); setAdding(false); setTick((t) => t + 1); }} />
      ) : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Строка бюджета</button>}
    </section>
  );
}

// ── Текстовый документ (протокол / уведомление) ──

export function TextDocument({ route, share }: { route: string; share?: boolean }) {
  const { data, error } = useOne<{ text: string; generatedAt?: string; disclaimer?: string }>(route);
  if (error) return <p className="generation-error">{error}</p>;
  if (!data) return <p>Загрузка…</p>;
  return (
    <section className="dtp-section">
      {data.disclaimer && <p className="dtp-status dtp-status--warn">{data.disclaimer}</p>}
      <pre className="dtp-protocol">{data.text}</pre>
      <div className="entity-form__actions">
        <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(data.text).then(() => haptic('success'))}>Скопировать</button>
        {share && <button type="button" className="secondary" onClick={() => shareViaTelegram(data.text)}>Отправить в Telegram</button>}
      </div>
      {data.generatedAt && <p className="dtp-muted">Сформировано {dateTime(data.generatedAt)}.</p>}
    </section>
  );
}
