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
import { ErrorBanner } from '../../../components/ErrorBanner';
import { OperatorTraceNotice } from '../../../components/OperatorTraceNotice';
import { operatorScreenActions } from '../../../lib/operator-screens';

export default function VenuesModerationPage() {
  const [applications, setApplications] = useState<VenueApplication[] | null>(null);
  const [approved, setApproved] = useState<ApprovedVenue[] | null>(null);
  // Пункт [decision-basis] 2026-09-04 — сбой действия больше не уносит
  // очередь. Здесь это было заметнее всего: даже неудачная загрузка
  // БОКОВОЙ сводки комиссий стирала весь список заявок. Существующий
  // `feeError` ниже — след того же изъяна: правило «не заменять страницу»
  // в проекте уже понимали, но обошли его в одном поле вместо того, чтобы
  // починить причину.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, CommissionSummary>>({});
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({});

  async function load() {
    try {
      const [queue, venues] = await Promise.all([listVenueModerationQueue(), listApprovedVenues()]);
      setApplications(queue);
      setApproved(venues);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function loadSummary(venueId: string) {
    // [project-audit] 2026-09-01: молчаливый сбой оставлял оператора
    // без сводки и без объяснения.
    try {
      const summary = await getVenueCommissionSummary(venueId);
      setSummaries((prev) => ({ ...prev, [venueId]: summary }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось загрузить сводку комиссий — остальные данные на экране не затронуты');
    }
  }

  if (loadError) return <div className="page"><p role="alert" style={{ color: 'var(--signal-critical)' }}>{loadError}</p></div>;
  if (!applications || !approved) return <div className="page"><p className="muted">Загрузка…</p></div>;

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Модерация заведений</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Заявки владельцев заведений (§3.23 ТЗ) и монетизация уже одобренных заведений (§3.22 ТЗ —
        реферальная плата реализована как леджер «к оплате», не реальный платёжный сбор — во всём
        проекте нет платёжной инфраструктуры).
      </p>
      {/* Пункт [operator-left-a-trace-unsaid] 2026-09-25: на этом экране
          четыре действия, и след у них РАЗНЫЙ — решение по заявке человек
          увидит, а признак партнёра и вознаграждение нет. Подписью «пишется
          в журнал» это не передать, поэтому ответ считает сервер. */}
      <OperatorTraceNotice actions={operatorScreenActions('app/moderation/venues/page.tsx')} />

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />

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
            // [project-audit] 2026-09-01: молча несработавшая модерация —
            // оператор думал, что одобрил; заявка возвращалась после F5.
            try {
              await moderateVenueApplication(app.id, 'APPROVE');
              setApplications((prev) => prev?.filter((a) => a.id !== app.id) ?? null);
              void load();
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Не удалось одобрить заявку — она осталась в очереди');
            }
          }}
          onReject={async (app) => {
            try {
              await moderateVenueApplication(app.id, 'REJECT');
              setApplications((prev) => prev?.filter((a) => a.id !== app.id) ?? null);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Не удалось отклонить заявку — она осталась в очереди');
            }
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
                <th>Отметки пользователей / расчётно</th>
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
                            // Отдельный feeError — ошибка ОДНОГО поля
                            // говорится у этого поля, а не общим
                            // баннером наверху. Раньше в этом
                            // комментарии стояла другая причина: общий
                            // error «заменяет собой всю страницу
                            // целиком». Он больше её не заменяет
                            // (Пункт [decision-basis] 2026-09-04), но
                            // отдельное поле по-прежнему право говорить
                            // за себя.
                            setFeeError(`Некорректное значение комиссии: "${raw}"`);
                            return;
                          }
                          setFeeError(null);
                          const amount = raw === undefined || raw === '' ? null : Number(raw);
                          try {
                            const updated = await setVenueReferralFee(venue.id, amount);
                            setApproved((prev) => prev?.map((v) => (v.id === venue.id ? updated : v)) ?? null);
                            setFeeDrafts((prev) => ({ ...prev, [venue.id]: '' }));
                          } catch (err) {
                            setFeeError(err instanceof Error ? err.message : 'Не удалось сохранить комиссию');
                          }
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
                          try {
                            const updated = await setVenuePriorityPartner(venue.id, e.target.checked);
                            setApproved((prev) => prev?.map((v) => (v.id === venue.id ? updated : v)) ?? null);
                          } catch (err) {
                            setFeeError(err instanceof Error ? err.message : 'Не удалось изменить статус партнёра');
                          }
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
                        {/* Пункт [self-reported-money] 2026-09-05:
                            «броней · к оплате» выглядело бухгалтерским
                            фактом. Обе цифры — из самоотчётов
                            пользователей: заведение их не подтверждало и
                            о них не знает. */}
                        {summaries[venue.id].totalBookingsConfirmed} отметок от{' '}
                        {summaries[venue.id].distinctReporters} чел. · расчётно{' '}
                        {summaries[venue.id].totalFeesOwed.toFixed(2)}
                        <div className="muted" style={{ fontSize: 12 }}>
                          Самоотчёты пользователей, не подтверждённые заведением. Это не счёт и не выставленная
                          сумма — платёжной инфраструктуры в проекте нет.
                        </div>
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
