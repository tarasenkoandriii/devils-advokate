'use client';

import { useEffect, useState } from 'react';
import {
  listVenueModerationQueue,
  moderateVenueApplication,
  listApprovedVenues,
  setVenueReferralFee,
  setVenuePriorityPartner,
  getVenueCommissionSummary,
} from '../../../lib/endpoints';
import { ModerationQueueTable } from '../../../components/ModerationQueueTable';
import type { VenueApplication, ApprovedVenue, CommissionSummary } from '../../../lib/types';

export default function VenuesModerationPage() {
  const [applications, setApplications] = useState<VenueApplication[] | null>(null);
  const [approved, setApproved] = useState<ApprovedVenue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, CommissionSummary>>({});
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({});

  async function load() {
    try {
      const [queue, venues] = await Promise.all([listVenueModerationQueue(), listApprovedVenues()]);
      setApplications(queue);
      setApproved(venues);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadSummary(venueId: string) {
    const summary = await getVenueCommissionSummary(venueId);
    setSummaries((prev) => ({ ...prev, [venueId]: summary }));
  }

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!applications || !approved) return <div className="page"><p className="muted">Загрузка…</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Модерация заведений</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Заявки владельцев заведений (§3.23 ТЗ) и монетизация уже одобренных заведений (§3.22 ТЗ —
        реферальная плата реализована как леджер «к оплате», не реальный платёжный сбор — во всём
        проекте нет платёжной инфраструктуры).
      </p>

      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Очередь заявок</h2>
        <ModerationQueueTable
          items={applications}
          columns={['Название', 'Адрес', 'Телефон']}
          acceptLabel="Одобрить"
          renderCells={(app) => (
            <>
              <td>{app.name}</td>
              <td>{app.address}</td>
              <td>{app.phone ?? '—'}</td>
            </>
          )}
          onAccept={async (app) => {
            await moderateVenueApplication(app.id, 'APPROVE');
            setApplications((prev) => prev?.filter((a) => a.id !== app.id) ?? null);
            load();
          }}
          onReject={async (app) => {
            await moderateVenueApplication(app.id, 'REJECT');
            setApplications((prev) => prev?.filter((a) => a.id !== app.id) ?? null);
          }}
        />
      </section>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Одобренные заведения — монетизация</h2>
        {feeError && (
          <p style={{ color: 'var(--signal-critical)', marginBottom: 12, fontSize: 13 }}>{feeError}</p>
        )}
        {approved.length === 0 && <p className="muted">Одобренных заведений пока нет.</p>}
        {approved.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Реферальная плата</th>
                <th>Приоритетное размещение</th>
                <th>Брони / к оплате</th>
              </tr>
            </thead>
            <tbody>
              {approved.map((venue) => (
                <tr key={venue.id}>
                  <td>{venue.name}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="number"
                        style={{ width: 90 }}
                        placeholder={venue.referralFeeAmount != null ? String(venue.referralFeeAmount) : 'не задано'}
                        value={feeDrafts[venue.id] ?? ''}
                        onChange={(e) => setFeeDrafts((prev) => ({ ...prev, [venue.id]: e.target.value }))}
                      />
                      <button
                        className="btn"
                        onClick={async () => {
                          const raw = feeDrafts[venue.id];
                          if (raw !== undefined && raw !== '' && !Number.isFinite(Number(raw))) {
                            // Аудит: Number('мусор') даёт NaN, а
                            // JSON.stringify(NaN) молча превращается в
                            // null — без этой проверки невалидный ввод
                            // тихо очищал бы комиссию вместо ошибки.
                            // Отдельный feeError, не page-level error —
                            // тот заменяет собой всю страницу целиком
                            // (см. `if (error) return ...` выше), что
                            // здесь было бы явно избыточной реакцией на
                            // ошибку одного поля в таблице.
                            setFeeError(`Некорректное значение комиссии: "${raw}"`);
                            return;
                          }
                          setFeeError(null);
                          const amount = raw === undefined || raw === '' ? null : Number(raw);
                          const updated = await setVenueReferralFee(venue.id, amount);
                          setApproved((prev) => prev?.map((v) => (v.id === venue.id ? updated : v)) ?? null);
                          setFeeDrafts((prev) => ({ ...prev, [venue.id]: '' }));
                        }}
                      >
                        Сохранить
                      </button>
                    </div>
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={venue.isPriorityPartner}
                        onChange={async (e) => {
                          const updated = await setVenuePriorityPartner(venue.id, e.target.checked);
                          setApproved((prev) => prev?.map((v) => (v.id === venue.id ? updated : v)) ?? null);
                        }}
                      />
                      <span className={venue.isPriorityPartner ? 'badge badge-ok' : 'muted'}>
                        {venue.isPriorityPartner ? 'Реклама' : 'Органика'}
                      </span>
                    </label>
                  </td>
                  <td>
                    {summaries[venue.id] ? (
                      <span>
                        {summaries[venue.id].totalBookingsConfirmed} броней ·{' '}
                        {summaries[venue.id].totalFeesOwed.toFixed(2)} к оплате
                      </span>
                    ) : (
                      <button className="btn" onClick={() => loadSummary(venue.id)}>
                        Показать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
