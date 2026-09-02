'use client';

// Фаза C ТЗ domain-ui §0 — ручные панели investment (группа: создать /
// приглашение / вступить / взнос / прогресс) и major-purchase (локация
// варианта: поиск по тексту, геолокация устройства с согласием LOCATION).
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { EntityForm } from './EntityForm';

import { haptic } from '../../lib/telegram';
import { ShareLinkView } from './InterviewPoolWorkspace';

export function InvestmentGroupPanel({ projectId, config }: { projectId: string; config: any }) {
  const [group, setGroup] = useState<any>(null);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [myGroups, setMyGroups] = useState<any[] | null>(null);
  useEffect(() => { domainApi.getJson('/investment-groups').then(setMyGroups).catch(() => setMyGroups([])); }, [tick]);
  const groupId: string | undefined = group?.id ?? config.investmentGroupId ?? config.project?.investmentGroupId ?? (myGroups && myGroups.length === 1 ? myGroups[0].id : undefined);

  return (
    <div className="domain-panel">
      <p className="card-section__empty">Совместные инвестиции: участники группы объявляют взносы, прогресс сбора виден всем. Суммы — в валюте конфига, между валютами не складываются.</p>
      {error && <p className="generation-error">{error}</p>}
      {myGroups && myGroups.length > 0 && (
        <ul className="dtp-access-log">{myGroups.map((g) => <li key={g.id}><strong>{g.name}</strong> · {g._count?.members ?? '?'} чел.{g.pledgedAmount != null && ` · мой взнос ${g.pledgedAmount}`}{g.id === groupId && ' · текущая'}{g.id !== groupId && <> <button type="button" className="secondary" onClick={() => setGroup(g)}>выбрать</button></>}</li>)}</ul>
      )}
      {groupId ? (
        <>
          <p>Группа: <strong>{myGroups?.find((g) => g.id === groupId)?.name ?? group?.name ?? groupId}</strong></p>
          <div className="entity-form__actions">
            <button type="button" className="secondary" onClick={async () => { try { const r = await domainApi.postJson(`/investment-groups/${groupId}/invite-link`, {}); setInvite({ link: String(r.deepLink ?? r.token ?? ''), expiresAt: String(r.expiresAt ?? '') }); } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка'); } }}>Ссылка-приглашение</button>
          </div>
          {/* Ревью 2026-09-02: показывался сырой ТОКЕН, а построенная
              сервером ссылка не использовалась вообще. */}
          {invite && <ShareLinkView link={invite.link} expiresAt={invite.expiresAt} onClose={() => setInvite(null)} />}
          <EntityForm fields={[{ name: 'pledgedAmount', label: 'Мой взнос', type: 'money', required: true }]} submitLabel="Объявить взнос"
            onSubmit={async (v) => { await domainApi.postJson(`/investment-groups/${groupId}/pledge`, v); haptic('success'); setTick((t) => t + 1); }} />
          <GroupProgress projectId={projectId} tick={tick} />
        </>
      ) : (
        <>
          <EntityForm fields={[{ name: 'name', label: 'Название группы', type: 'text', required: true }]} submitLabel="Создать группу" onSubmit={async (v) => { setGroup(await domainApi.postJson('/investment-groups', v)); setTick((t) => t + 1); }} />
          <EntityForm fields={[{ name: 'token', label: 'Токен приглашения', type: 'text', required: true }]} submitLabel="Вступить по токену"
            onSubmit={async (v) => { const t = String(v.token); const r = await domainApi.postJson(`/investment-groups/${t}/join`, { token: t }); setGroup(r.group ?? r); setTick((x) => x + 1); }} />
          <p className="card-section__empty">Проект привязывается к группе при создании (поле investmentGroupId) — для существующего проекта создайте новый, указав группу.</p>
        </>
      )}
    </div>
  );
}

function GroupProgress({ projectId, tick }: { projectId: string; tick: number }) {
  const [data, setData] = useState<{ targetBudget: number | null; currency: string | null; totalPledged: number; members: Array<{ id: string; userId: string; pledgedAmount: number | null; role?: string }> } | null>(null);
  useEffect(() => { domainApi.getJson(`/investment/projects/${projectId}/group-progress`).then(setData).catch(() => setData(null)); }, [projectId, tick]);
  if (!data) return <p className="dtp-muted">Прогресс: загрузка…</p>;
  const pct = data.targetBudget ? Math.min(100, Math.round((data.totalPledged / data.targetBudget) * 100)) : null;
  return (
    <div style={{ width: '100%' }}>
      <div className="dtp-facts">
        <div><span className="dtp-facts__label">Собрано взносов</span><strong>{new Intl.NumberFormat('ru-RU').format(data.totalPledged)} {data.currency ?? ''}</strong></div>
        <div><span className="dtp-facts__label">Цель</span><strong>{data.targetBudget !== null ? `${new Intl.NumberFormat('ru-RU').format(data.targetBudget)} ${data.currency ?? ''}` : '—'}</strong></div>
        <div><span className="dtp-facts__label">Участников</span><strong>{data.members.length}</strong></div>
      </div>
      {pct !== null && <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'var(--tg-theme-secondary-bg-color, #eee)', marginTop: 8 }}><div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: 'var(--tg-theme-button-color, #2481cc)' }} /></div>}
      <ul className="dtp-access-log" style={{ marginTop: 8 }}>{data.members.map((m) => <li key={m.id}>{m.userId.slice(0, 8)}… — {m.pledgedAmount !== null ? `${new Intl.NumberFormat('ru-RU').format(m.pledgedAmount)} ${data.currency ?? ''}` : 'взнос не объявлен'}</li>)}</ul>
    </div>
  );
}

const LOCATION_CONSENT_VERSION = 'major-purchase-location-v1';

export function VariantLocationPanel({ configId }: { configId: string }) {
  const [variants, setVariants] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, any[]>>({});
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    domainApi.getJson(`/major-purchase/configs/${configId}/variants`).then((d) => setVariants(Array.isArray(d) ? d : [])).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [configId, tick]);

  async function withConsent<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e: any) {
      if (e?.httpStatus === 403 || /consent|соглас|згод/i.test(String(e?.message))) {
        if (!window.confirm('Для определения расстояний и маршрутов нужно согласие на обработку геолокации. Дать согласие?')) throw e;
        await domainApi.postJson('/major-purchase/location-consent', { version: LOCATION_CONSENT_VERSION });
        return fn();
      }
      throw e;
    }
  }

  async function search(variantId: string) {
    if (!query.trim()) return;
    setBusy(true); setError(null);
    try { const r = await withConsent(() => domainApi.getJson(`/major-purchase/variants/${variantId}/location-search?query=${encodeURIComponent(query.trim())}`)); setResults((p) => ({ ...p, [variantId]: Array.isArray(r) ? r : r?.results ?? [] })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Поиск недоступен'); }
    finally { setBusy(false); }
  }
  async function setPlace(variantId: string, placeId: string) {
    setBusy(true); setError(null);
    try { await withConsent(() => domainApi.patchJson(`/major-purchase/variants/${variantId}/location/place-id`, { placeId })); haptic('success'); setResults((p) => ({ ...p, [variantId]: [] })); setTick((t) => t + 1); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  }
  // Функция НЕ хук: имя useDevice нарушало соглашение React
  // (use*-префикс) и rules-of-hooks справедливо ругался на вызов из
  // onClick-колбэка. Переименована — поведение не менялось.
  async function takeDeviceLocation(variantId: string) {
    if (!('geolocation' in navigator)) { setError('Геолокация недоступна в этом окружении'); return; }
    setBusy(true); setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try { await withConsent(() => domainApi.patchJson(`/major-purchase/variants/${variantId}/location/geolocation`, { latitude: pos.coords.latitude, longitude: pos.coords.longitude })); haptic('success'); setTick((t) => t + 1); }
        catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
        finally { setBusy(false); }
      },
      () => { setError('Доступ к геолокации не предоставлен'); setBusy(false); },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  return (
    <div className="domain-panel">
      <p className="card-section__empty">Где находится каждый вариант — чтобы сравнивать расстояния. Координаты хранятся только с вашего согласия на геолокацию.</p>
      {error && <p className="generation-error">{error}</p>}
      {variants.length === 0 && <p className="card-section__empty">Сначала добавьте варианты во вкладке «Варианты».</p>}
      <ul className="domain-entities">
        {variants.map((v) => (
          <li key={v.id} className="domain-entities__item">
            <div className="domain-sessions__head"><strong>{v.label}</strong><span className="domain-badge">{v.latitude != null ? `${Number(v.latitude).toFixed(4)}, ${Number(v.longitude).toFixed(4)}` : v.placeId ? 'place' : 'нет локации'}</span></div>
            {v.formattedAddress && <p>{v.formattedAddress}</p>}
            <div className="voice-text-input__row" style={{ width: '100%' }}>
              <input style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Адрес или название" />
              <button type="button" className="secondary" disabled={busy} onClick={() => search(v.id)}>Найти</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => takeDeviceLocation(v.id)}>Я здесь</button>
            </div>
            {(results[v.id] ?? []).map((r: any) => (
              <button key={r.placeId ?? r.place_id} type="button" className="secondary" disabled={busy} onClick={() => setPlace(v.id, r.placeId ?? r.place_id)}>
                {r.name ?? r.formattedAddress ?? r.formatted_address ?? r.placeId}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ShareAllPanel({ projectId }: { projectId: string }) {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    domainApi.getJson(`/interview-pool/projects/${projectId}/candidates`).then((d) => setCandidates(Array.isArray(d) ? d : [])).catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'));
  }, [projectId]);
  const ids = Object.entries(checked).filter(([, v]) => v).map(([k]) => k);
  return (
    <div className="domain-panel">
      <p className="card-section__empty">Передать профили заказчику можно только для кандидатов, чьё согласие вы подтверждаете явно — по одному.</p>
      {error && <p className="generation-error">{error}</p>}
      {candidates.map((s) => (
        <label key={s.id}><input type="checkbox" checked={Boolean(checked[s.candidateProfileId])} onChange={(e) => setChecked({ ...checked, [s.candidateProfileId]: e.target.checked })} /> {s.candidateProfile?.displayName ?? s.candidateProfileId} — согласие подтверждаю</label>
      ))}
      <button type="button" className="primary" disabled={ids.length === 0} onClick={async () => { try { setResult(await domainApi.postJson(`/interview-pool/projects/${projectId}/share-all`, { candidateConsentConfirmed: ids })); haptic('success'); } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка'); } }}>Передать выбранных ({ids.length})</button>
      {/* Ревью 2026-09-02: ответ содержит deepLink на весь пакет, а
          показывался только счётчик — ссылку, по которой получатель
          принимает профили, отправить было нечем. Поля shared/count в
          ответе нет, счёт берём из includedCount. */}
      {result && (
        <>
          <p className="dtp-status dtp-status--ok">Передано: {result.includedCount ?? ids.length} профил(ей){result.excludedCount ? `, без согласия пропущено: ${result.excludedCount}` : ''}.</p>
          {result.deepLink && <ShareLinkView link={String(result.deepLink)} expiresAt={String(result.expiresAt ?? '')} onClose={() => setResult(null)} />}
        </>
      )}
    </div>
  );
}
