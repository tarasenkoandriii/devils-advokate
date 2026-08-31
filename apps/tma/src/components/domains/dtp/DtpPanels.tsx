'use client';

// Доменная вёрстка ДТП — образец для остальных доменов (замена generic
// JsonView). Принцип: каждая вкладка знает форму данных своего backend
// и показывает то, что важно пользователю в этой ситуации — роль
// участника, есть ли страховка, официально ли определена вина, что
// именно сказал каждый консультант по каждому критерию. Формы ввода
// остаются EntityForm (по манифесту) — переписывать их смысла нет.
import { useEffect, useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { EntitySpec } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { SourceCard, useList } from '../shared/ConsultationPipeline';
import {
  DtpAdvisor, DtpConfig, DtpCriterion, DtpFaultDetermination, DtpParticipant,
  CATEGORY_LABEL, ROLE_LABEL, FAULT_SOURCE_LABEL, dateOnly, dateTime, money,
} from './dtp-types';

export const useDtpList = useList;

// ── Обзор ──

export function DtpOverview({ config, counts }: { config: DtpConfig; counts: { participants: number; evidence: number; advisors: number } }) {
  const grouped = new Map<string, DtpCriterion[]>();
  for (const c of config.criteria ?? []) grouped.set(c.category, [...(grouped.get(c.category) ?? []), c]);
  return (
    <section className="dtp-overview">
      <div className="dtp-facts">
        <div><span className="dtp-facts__label">Когда</span><strong>{dateTime(config.occurredAt)}</strong></div>
        <div><span className="dtp-facts__label">Целевой бюджет</span><strong>{money(config.targetBudget, config.currency)}</strong></div>
        <div><span className="dtp-facts__label">Участников</span><strong>{counts.participants}</strong></div>
        <div><span className="dtp-facts__label">Доказательств</span><strong>{counts.evidence}</strong></div>
        <div><span className="dtp-facts__label">Консультантов</span><strong>{counts.advisors}</strong></div>
      </div>
      <p className="dtp-goal">{config.goalDescription}</p>
      <h3>Критерии — что нужно выяснить</h3>
      {grouped.size === 0 && <p className="card-section__empty">Критериев нет — они появляются из онбординга.</p>}
      {[...grouped.entries()].map(([cat, items]) => (
        <div key={cat} className="dtp-criteria-group">
          <h4>{CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] ?? cat}</h4>
          <ul>
            {items.map((c) => <li key={c.id}>{c.isRequired && <span className="dtp-badge dtp-badge--req">обязательно</span>} {c.text}</li>)}
          </ul>
        </div>
      ))}
      <p className="dtp-hint">Дальше: зафиксируйте участников и доказательства, затем добавляйте консультации — по каждой AI разложит сказанное по этим критериям, а вкладка «Сравнение» покажет всех консультантов рядом.</p>
    </section>
  );
}

// ── Консультанты и консультации ──

export function DtpAdvisors({ configId, criteria, spec }: { configId: string; criteria: DtpCriterion[]; spec: EntitySpec }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error } = useDtpList<DtpAdvisor>(`/dtp/configs/${configId}/advisors`, tick);
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Юрист, оценщик, страховой агент — каждый отдельно. Приложение не ранжирует их: оно показывает, что каждый сказал по вашим критериям, чтобы расхождения были видны.</p>
      {error && <p className="generation-error">{error}</p>}
      {data && data.length === 0 && <p className="card-section__empty">Консультантов пока нет.</p>}
      {data?.map((a) => <SourceCard key={a.id} source={a} subtitle={a.advisorName} badge={a.role} criteria={criteria} spec={spec} routes={{ generate: (id) => `/dtp/consultations/${id}/generate-breakdown`, review: (id) => `/dtp/consultations/${id}/review` }} />)}
      {adding ? (
        <EntityForm fields={spec.fields} submitLabel="Добавить консультанта" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(`/dtp/configs/${configId}/advisors`, v); setAdding(false); setTick((t) => t + 1); }} />
      ) : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Консультант</button>}
    </section>
  );
}

// ── Участники и страховка ──

function ParticipantCard({ p, spec, onChanged }: { p: DtpParticipant; spec: EntitySpec; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [ins, setIns] = useState<DtpParticipant['insurance']>(p.insurance ?? undefined);
  useEffect(() => {
    if (p.insurance !== undefined) return;
    domainApi.getJson(`/dtp/participants/${p.id}/insurance`).then(setIns).catch(() => setIns(null));
  }, [p.id, p.insurance]);
  const insuranceAction = spec.actions?.find((a) => a.key === 'insurance');
  return (
    <div className="dtp-card">
      <div className="dtp-card__head dtp-card__head--static">
        <span><span className={`dtp-badge dtp-badge--role-${p.role.toLowerCase()}`}>{ROLE_LABEL[p.role]}</span> <strong>{p.displayName ?? 'без имени'}</strong></span>
        {p.hasFledScene && <span className="dtp-badge dtp-badge--bad">скрылся с места</span>}
      </div>
      <div className="dtp-card__body">
        {ins === undefined && <p className="dtp-muted">Страховка: загрузка…</p>}
        {ins === null && <p className="dtp-muted">Страховка: не указана</p>}
        {ins && (ins.hasInsurance
          ? <p>Страховка: <strong>{ins.insurerName ?? 'страховщик не указан'}</strong>{ins.policyType && ` · ${ins.policyType}`}{ins.coverageAmount !== null && ` · покрытие ${money(ins.coverageAmount, ins.currency)}`}</p>
          : <p className="dtp-warn">Страховки нет — расходы этой стороны лягут на неё напрямую.</p>)}
        {insuranceAction && (editing ? (
          <EntityForm fields={insuranceAction.fields} initial={ins ? { ...ins } : undefined} submitLabel="Сохранить страховку" onCancel={() => setEditing(false)}
            onSubmit={async (v) => { const saved = await domainApi.postJson(insuranceAction.route(p.id), v); setIns(saved); setEditing(false); onChanged(); }} />
        ) : <button type="button" className="secondary" onClick={() => setEditing(true)}>{ins ? 'Изменить страховку' : 'Указать страховку'}</button>)}
      </div>
    </div>
  );
}

export function DtpParticipants({ configId, spec }: { configId: string; spec: EntitySpec }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error } = useDtpList<DtpParticipant>(`/dtp/configs/${configId}/participants`, tick);
  const hasSelf = data?.some((p) => p.role === 'SELF');
  return (
    <section className="dtp-section">
      {error && <p className="generation-error">{error}</p>}
      {data && !hasSelf && <p className="dtp-hint">Добавьте себя (роль «Я») — без этого бюджет и протокол не смогут отделить ваши расходы от чужих.</p>}
      {data?.map((p) => <ParticipantCard key={p.id} p={p} spec={spec} onChanged={() => setTick((t) => t + 1)} />)}
      {adding ? (
        <EntityForm fields={spec.fields} submitLabel="Добавить участника" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(`/dtp/configs/${configId}/participants`, v); setAdding(false); setTick((t) => t + 1); }} />
      ) : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Участник</button>}
    </section>
  );
}

// ── Определение вины ──

export function DtpFault({ configId, spec }: { configId: string; spec: EntitySpec }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error } = useDtpList<DtpFaultDetermination>(`/dtp/configs/${configId}/fault-determinations`, tick);
  const sorted = [...(data ?? [])].sort((a, b) => +new Date(b.determinedAt) - +new Date(a.determinedAt));
  const official = sorted.find((d) => d.isOfficial);
  return (
    <section className="dtp-section">
      {error && <p className="generation-error">{error}</p>}
      {official
        ? <p className="dtp-status dtp-status--ok">Официально: <strong>{official.statusText}</strong> · {FAULT_SOURCE_LABEL[official.source] ?? official.source}{official.referenceDocumentNumber && ` · № ${official.referenceDocumentNumber}`} · {dateOnly(official.determinedAt)}</p>
        : <p className="dtp-status dtp-status--warn">Официального определения вины пока нет — всё ниже это мнения, не решения.</p>}
      <ol className="dtp-timeline">
        {sorted.map((d) => (
          <li key={d.id} className={d.isOfficial ? 'dtp-timeline__item dtp-timeline__item--official' : 'dtp-timeline__item'}>
            <time>{dateOnly(d.determinedAt)}</time>
            <div><strong>{d.statusText}</strong><br /><span className="dtp-muted">{FAULT_SOURCE_LABEL[d.source] ?? d.source}{d.isOfficial ? ' · официально' : ' · мнение'}{d.referenceDocumentNumber && ` · № ${d.referenceDocumentNumber}`}</span></div>
          </li>
        ))}
      </ol>
      {adding ? (
        <EntityForm fields={spec.fields} submitLabel="Добавить запись" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(`/dtp/configs/${configId}/fault-determinations`, v); setAdding(false); setTick((t) => t + 1); }} />
      ) : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Запись о вине</button>}
    </section>
  );
}
