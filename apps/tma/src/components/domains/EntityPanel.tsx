'use client';

// ТЗ §0 — EntityList/EntityForm + SessionPanel для вкладки сущности
// (консультанты/врачи/предложения/варианты/участники/…): список,
// создание, действия, подпанели и сессии (консультации/встречи →
// generate → review) — всё по EntitySpec из манифеста.
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { EntitySpec, SessionSpec } from '../../lib/domains/types';
import { EntityForm } from './EntityForm';
import { JsonPanel, JsonView, renderValue } from './JsonPanel';
import { haptic } from '../../lib/telegram';

function SessionDetail({ label, route }: { label: string; route: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ width: '100%' }}>
      <button type="button" className="secondary" onClick={() => setOpen(!open)}>{label}</button>
      {open && <JsonPanel route={route} />}
    </div>
  );
}

function SessionPanel({ spec, entityId }: { spec: SessionSpec; entityId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    domainApi.getJson(spec.listRoute(entityId))
      .then((d) => setItems(Array.isArray(d) ? d : Array.isArray(d?.meetings) ? d.meetings : Array.isArray(d?.consultations) ? d.consultations : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [spec, entityId, tick]);

  async function generate(id: string) {
    setBusyId(id); setError(null);
    try { await domainApi.postJson(spec.generateRoute(id), {}); haptic('success'); setTick((t) => t + 1); }
    catch (e) { haptic('error'); setError(e instanceof Error ? e.message : 'Не удалось разобрать'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="domain-sessions">
      <h4>{spec.label}</h4>
      {error && <p className="generation-error">{error}</p>}
      {items.length === 0 && <p className="card-section__empty">Пока нет ни одной — добавьте после встречи.</p>}
      <ul className="domain-sessions__list">
        {items.map((s) => (
          <li key={s.id}>
            <div className="domain-sessions__head">
              <span>{s.occurredAt ? new Date(s.occurredAt).toLocaleString() : s.id}</span>
              <span className="domain-badge">{s.status ?? (s.reviewedAt ? 'REVIEWED' : s.breakdown || s.conclusionDraft || s.conclusion ? 'GENERATED' : 'NEW')}</span>
            </div>
            {(s.breakdown || s.conclusionDraft || s.conclusion) && <JsonView data={s.breakdown ?? s.conclusionDraft ?? s.conclusion} />}
            {spec.detailPanels?.map((p) => <SessionDetail key={p.key} label={p.label} route={p.route(s.id)} />)}
            <div className="entity-form__actions">
              <button type="button" className="secondary" disabled={busyId === s.id} onClick={() => generate(s.id)}>{busyId === s.id ? '…' : spec.generateLabel}</button>
              <button type="button" className="secondary" onClick={() => setReviewId(reviewId === s.id ? null : s.id)}>Отметить разобранной</button>
            </div>
            {reviewId === s.id && (
              <EntityForm fields={spec.reviewFields} submitLabel="Сохранить разбор" onCancel={() => setReviewId(null)}
                onSubmit={async (v) => { await domainApi.postJson(spec.reviewRoute(s.id), v); setReviewId(null); setTick((t) => t + 1); }} />
            )}
          </li>
        ))}
      </ul>
      {creating ? (
        <EntityForm fields={spec.fields} submitLabel={`Добавить · ${spec.singular}`} onCancel={() => setCreating(false)}
          onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(entityId), v); setCreating(false); setTick((t) => t + 1); }} />
      ) : (
        <button type="button" className="secondary" onClick={() => setCreating(true)}>+ {spec.singular}</button>
      )}
    </div>
  );
}

export function EntityPanel({ spec, configId }: { spec: EntitySpec; configId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    domainApi.getJson(spec.listRoute(configId))
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [spec, configId, tick]);

  return (
    <div className="domain-panel">
      {error && <p className="generation-error">{error}</p>}
      {items.length === 0 && !error && <p className="card-section__empty">Пока нет ни одной записи.</p>}
      <ul className="domain-entities">
        {items.map((it) => (
          <li key={it.id} className={openId === it.id ? 'domain-entities__item domain-entities__item--open' : 'domain-entities__item'}>
            <button type="button" className="domain-entities__title" onClick={() => setOpenId(openId === it.id ? null : it.id)}>
              {renderValue(it[spec.titleField])}
            </button>
            {openId === it.id && (
              <div className="domain-entities__body">
                <JsonView data={Object.fromEntries(Object.entries(it).filter(([k]) => !/^(id|.*Id|createdAt|updatedAt)$/.test(k)))} />
                {spec.detailPanels?.map((p) => <JsonPanel key={p.key} title={p.label} route={p.route(it.id)} refreshKey={tick} />)}
                {spec.actions?.map((a) => (
                  <div key={a.key}>
                    {actionKey === `${it.id}:${a.key}` ? (
                      <EntityForm fields={a.fields} submitLabel={a.label} onCancel={() => setActionKey(null)}
                        onSubmit={async (v) => {
                          if (a.method === 'PATCH') await domainApi.patchJson(a.route(it.id), v); else await domainApi.postJson(a.route(it.id), v);
                          setActionKey(null); setTick((t) => t + 1);
                        }} />
                    ) : (
                      <button type="button" className="secondary" onClick={() => setActionKey(`${it.id}:${a.key}`)}>{a.label}</button>
                    )}
                  </div>
                ))}
                {spec.sessions && <SessionPanel spec={spec.sessions} entityId={it.id} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {creating ? (
        <EntityForm fields={spec.fields} submitLabel={`Добавить · ${spec.singular}`} onCancel={() => setCreating(false)}
          onSubmit={async (v) => { await domainApi.postJson(spec.createRoute(configId), v); setCreating(false); setTick((t) => t + 1); }} />
      ) : (
        <button type="button" className="primary" onClick={() => setCreating(true)}>+ {spec.singular}</button>
      )}
    </div>
  );
}
