'use client';

import { useEffect, useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { haptic } from '../../../lib/telegram';
import { DtpAdvisors, DtpFault, DtpOverview, DtpParticipants, useDtpList } from './DtpPanels';
import { BudgetByCurrency, ComparisonMatrix, CrossCheckList, TextDocument } from '../shared/ConsultationPipeline';
import { DtpConfig, DtpEvidenceAccess, DtpEvidenceItem, BUDGET_CATEGORY_LABEL, dateTime } from './dtp-types';

// ── Доказательства ──

function EvidenceCard({ e }: { e: DtpEvidenceItem }) {
  const [log, setLog] = useState<DtpEvidenceAccess[] | null>(null);
  return (
    <div className="dtp-evidence">
      <div className="dtp-evidence__icon">{e.mediaType === 'VIDEO' ? '🎥' : '📷'}</div>
      <div className="dtp-evidence__body">
        <strong>{e.mediaType === 'VIDEO' ? 'Видео' : 'Фото'}{e.hasAudio && ' со звуком'}</strong>
        <div className="dtp-muted">снято {dateTime(e.capturedAt)}</div>
        <div className="dtp-muted">{e.latitude !== null && e.longitude !== null ? `📍 ${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}` : 'без геометки'} · хеш {e.fileHash.slice(0, 10)}…</div>
        <div className="entity-form__actions">
          {e.blobUrl && <a className="dtp-link" href={e.blobUrl} target="_blank" rel="noreferrer">Открыть</a>}
          <button type="button" className="secondary" onClick={() => log ? setLog(null) : domainApi.getJson(`/dtp/evidence/${e.id}/access-log`).then(setLog)}>{log ? 'Скрыть журнал' : 'Журнал доступа'}</button>
        </div>
        {log && (
          <ul className="dtp-access-log">
            {log.length === 0 && <li className="dtp-muted">Доступов не было.</li>}
            {log.map((l) => <li key={l.id}>{dateTime(l.occurredAt)}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

export function DtpEvidence({ configId, manifest }: { configId: string; manifest: DomainManifest }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const spec = manifest.entities.find((e) => e.key === 'evidence')!;
  const { data, error } = useDtpList<DtpEvidenceItem>(`/dtp/configs/${configId}/evidence`, tick);
  return (
    <section className="dtp-section">
      <p className="dtp-hint">Файл получает хеш и время фиксации при загрузке, каждый просмотр пишется в журнал — это и есть «доказательная фиксация»: вы сможете показать, что снимок не менялся. Геометка — только по вашему согласию.</p>
      {error && <p className="generation-error">{error}</p>}
      {data && data.length === 0 && <p className="card-section__empty">Пока ничего не зафиксировано. Снимите повреждения, номера, положение машин, знаки.</p>}
      {data?.map((e) => <EvidenceCard key={e.id} e={e} />)}
      {adding ? (
        <EntityForm fields={spec.fields} initial={{ capturedAt: new Date().toISOString(), hasAudio: false }} submitLabel="Зафиксировать" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(`/dtp/configs/${configId}/evidence`, v); haptic('success'); setAdding(false); setTick((t) => t + 1); }} />
      ) : <button type="button" className="primary" onClick={() => setAdding(true)}>+ Фото / видео</button>}
    </section>
  );
}

// ── Оболочка ──

const TABS = [
  { key: 'overview', label: 'Обзор' }, { key: 'participants', label: 'Участники' }, { key: 'evidence', label: 'Доказательства' },
  { key: 'advisors', label: 'Консультанты' }, { key: 'comparison', label: 'Сравнение' }, { key: 'cross', label: 'Сверка' },
  { key: 'budget', label: 'Бюджет' }, { key: 'protocol', label: 'Соглашение' }, { key: 'fault', label: 'Вина' },
];

export function DtpWorkspace({ config, manifest }: { config: DtpConfig; manifest: DomainManifest }) {
  const [tab, setTab] = useState('overview');
  const [counts, setCounts] = useState({ participants: 0, evidence: 0, advisors: 0 });
  useEffect(() => {
    Promise.all([
      domainApi.getJson(`/dtp/configs/${config.id}/participants`).catch(() => []),
      domainApi.getJson(`/dtp/configs/${config.id}/evidence`).catch(() => []),
      domainApi.getJson(`/dtp/configs/${config.id}/advisors`).catch(() => []),
    ]).then(([p, e, a]) => setCounts({ participants: p.length ?? 0, evidence: e.length ?? 0, advisors: a.length ?? 0 }));
  }, [config.id, tab]);
  const entity = (key: string) => manifest.entities.find((e) => e.key === key)!;
  return (
    <>
      <nav className="domain-tabs">
        {TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>
      {tab === 'overview' && <DtpOverview config={config} counts={counts} />}
      {tab === 'participants' && <DtpParticipants configId={config.id} spec={entity('participants')} />}
      {tab === 'evidence' && <DtpEvidence configId={config.id} manifest={manifest} />}
      {tab === 'advisors' && <DtpAdvisors configId={config.id} criteria={config.criteria} spec={entity('advisors')} />}
      {tab === 'comparison' && <ComparisonMatrix route={`/dtp/configs/${config.id}/comparison-table`} sourceNoun="консультантов" />}
      {tab === 'cross' && <CrossCheckList route={`/dtp/configs/${config.id}/cross-consultation-check`} criteria={config.criteria} sourceNoun="консультантами" />}
      {tab === 'budget' && <BudgetByCurrency route={`/dtp/configs/${config.id}/budget`} createRoute={`/dtp/configs/${config.id}/budget-line-items`} fields={manifest.extras.find((x) => x.key === 'budget')!.budgetFields!} categoryLabels={BUDGET_CATEGORY_LABEL} />}
      {tab === 'protocol' && <TextDocument route={`/dtp/configs/${config.id}/settlement-protocol-draft`} share />}
      {tab === 'fault' && <DtpFault configId={config.id} spec={entity('fault')} />}
    </>
  );
}
