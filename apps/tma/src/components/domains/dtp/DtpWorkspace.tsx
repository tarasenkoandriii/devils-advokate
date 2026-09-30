'use client';

import { useEffect, useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { haptic } from '../../../lib/telegram';
import { DtpAdvisors, DtpFault, DtpOverview, DtpParticipants, useDtpList, type DtpCounts } from './DtpPanels';
import { BudgetByCurrency, ComparisonMatrix, CrossCheckList, TextDocument } from '../shared/ConsultationPipeline';
import { DtpConfig, DtpEvidenceAccess, DtpEvidenceItem, BUDGET_CATEGORY_LABEL, dateTime } from './dtp-types';
import { checkLocationConsent, LocationConsentPrompt } from '../../LocationConsentPrompt';
import { LOCATION_PURPOSES } from '../../../lib/location-purposes';

// ── Доказательства ──

function EvidenceCard({ e }: { e: DtpEvidenceItem }) {
  const [log, setLog] = useState<DtpEvidenceAccess[] | null>(null);
  const [notRecorded, setNotRecorded] = useState(false);
  return (
    <div className="dtp-evidence">
      <div className="dtp-evidence__icon">{e.mediaType === 'VIDEO' ? '🎥' : '📷'}</div>
      <div className="dtp-evidence__body">
        <strong>{e.mediaType === 'VIDEO' ? 'Видео' : 'Фото'}{e.hasAudio && ' со звуком'}</strong>
        <div className="dtp-muted">снято {dateTime(e.capturedAt)}</div>
        <div className="dtp-muted">{e.latitude !== null && e.longitude !== null ? `📍 ${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}` : 'без геометки'} · хеш {e.fileHash.slice(0, 10)}…</div>
        <div className="entity-form__actions">
          {/* Пункт [the-log-that-logged-nothing] 2026-09-30: это была
              ПРОСТАЯ ССЫЛКА на Blob — файл открывался минуя сервер, и
              журнал доступа оставался всегда пуст, при том что экран
              обещал «каждый просмотр пишется в журнал». Теперь
              открытие сначала отмечается, и только потом файл
              открывается. Отказ записи не мешает открыть своё
              доказательство, но молчать о нём нельзя: журнал — это то,
              чем человек собирается доказывать. */}
          {e.blobUrl && (
            <button
              type="button"
              className="dtp-link"
              onClick={async () => {
                try {
                  await domainApi.postJson(`/dtp/evidence/${e.id}/opened`, {});
                  setNotRecorded(false);
                } catch {
                  setNotRecorded(true);
                }
                window.open(e.blobUrl!, '_blank', 'noreferrer');
              }}
            >
              Открыть
            </button>
          )}
          <button type="button" className="secondary" onClick={() => log ? setLog(null) : domainApi.getJson(`/dtp/evidence/${e.id}/access-log`).then(setLog)}>{log ? 'Скрыть журнал' : 'Журнал доступа'}</button>
        </div>
        {notRecorded && (
          <p role="alert" className="dtp-status dtp-status--warn">
            Это открытие в журнал доступа записать не удалось — сам файл открыт, но в журнале его не будет.
          </p>
        )}
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
  // Пункт [consent-purpose] 2026-09-05: у геометки на доказательстве не
  // было СВОЕЙ двери вовсе. Согласие требовалось (`requireConsent`
  // LOCATION), но спросить его на этом экране было негде — оно
  // приезжало из экрана погоды, где написано «координаты никогда не
  // сохраняются». Здесь координаты остаются в материале, который
  // человек собирается кому-то предъявлять.
  const [pendingGeo, setPendingGeo] = useState<Record<string, unknown> | null>(null);
  const spec = manifest.entities.find((e) => e.key === 'evidence')!;
  const { data, error } = useDtpList<DtpEvidenceItem>(`/dtp/configs/${configId}/evidence`, tick);

  async function saveEvidence(v: Record<string, unknown>) {
    await domainApi.postJson(`/dtp/configs/${configId}/evidence`, v);
    haptic('success');
    setAdding(false);
    setPendingGeo(null);
    setTick((t) => t + 1);
  }

  async function submitEvidence(v: Record<string, unknown>) {
    const hasGeo = v.latitude !== undefined && v.latitude !== null && v.latitude !== ''
      && v.longitude !== undefined && v.longitude !== null && v.longitude !== '';
    if (hasGeo && !(await checkLocationConsent(LOCATION_PURPOSES.DTP_EVIDENCE))) {
      setPendingGeo(v);
      return;
    }
    await saveEvidence(v);
  }

  return (
    <section className="dtp-section">
      {/* Пункт [the-log-that-logged-nothing] 2026-09-30: здесь стояло
          «каждый просмотр пишется в журнал» — и журнал был всегда
          пуст. Теперь сказано ровно то, что записывается, и названо
          то, что НЕ записывается: ссылку на файл можно передать, и
          чужое открытие по ней продукт не увидит. */}
      <p className="dtp-hint">Файл получает хеш и время фиксации при загрузке — это и есть «доказательная фиксация»: вы сможете показать, что снимок не менялся. Каждое открытие файла отсюда пишется в журнал доступа. Если вы передали ссылку на файл кому-то ещё, его открытия продукт не увидит — журнал знает только то, что происходит в нём. Геометка — только по вашему согласию, и она сохраняется вместе с файлом.</p>
      {error && <p role="alert" className="generation-error">{error}</p>}
      {pendingGeo && (
        <LocationConsentPrompt
          source="dtp-evidence"
          purposes={[LOCATION_PURPOSES.DTP_EVIDENCE]}
          onGranted={() => { void saveEvidence(pendingGeo); }}
          onCancel={() => setPendingGeo(null)}
        />
      )}
      {data && data.length === 0 && <p className="card-section__empty">Пока ничего не зафиксировано. Снимите повреждения, номера, положение машин, знаки.</p>}
      {data?.map((e) => <EvidenceCard key={e.id} e={e} />)}
      {adding ? (
        <EntityForm fields={spec.fields} initial={{ capturedAt: new Date().toISOString(), hasAudio: false }} submitLabel="Зафиксировать" onCancel={() => setAdding(false)}
          onSubmit={submitEvidence} />
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
  // Пункт [zero-was-a-failure] 2026-09-30: здесь стояли три
  // `.catch(() => [])` без причины и `?? 0` поверх них — то есть сбой
  // любой из трёх загрузок печатался на вкладке «Обзор» жирными
  // нулями в блоке ФАКТОВ о ДТП человека: «Участников 0 ·
  // Доказательств 0 · Консультантов 0». Ни пометки, ни role="alert".
  // Остальные вкладки того же воркспейса построены честно — `useDtpList`
  // отдаёт `error`, и панели его показывают; не показывала ровно та
  // вкладка, которая открывается первой и на которую человек смотрит,
  // решая, собрал ли он доказательства для страховой.
  //
  // `null` вместо нуля: «неизвестно» и «ноль» — разные ответы, и
  // отличить их обязан экран, а не человек.
  const [counts, setCounts] = useState<DtpCounts>({ participants: null, evidence: null, advisors: null });
  useEffect(() => {
    const len = (v: unknown) => (Array.isArray(v) ? v.length : null);
    void Promise.all([
      domainApi.getJson(`/dtp/configs/${config.id}/participants`).catch(() => null),
      domainApi.getJson(`/dtp/configs/${config.id}/evidence`).catch(() => null),
      domainApi.getJson(`/dtp/configs/${config.id}/advisors`).catch(() => null),
    ]).then(([p, e, a]) => setCounts({ participants: len(p), evidence: len(e), advisors: len(a) }));
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
