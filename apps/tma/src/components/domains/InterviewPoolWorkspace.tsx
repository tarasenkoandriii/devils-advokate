'use client';

// Фаза C ТЗ domain-ui §0 — ручные панели interview-pool: то, что не
// ложится в манифест (опросник, кандидаты+pipeline, релевантность,
// команда, шаринг, отчёты заказчику). Все пути — из interview-pool.controller.
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { EntityForm } from './EntityForm';
import { JsonPanel } from './JsonPanel';
import { AgendaView, RelevanceSnapshotView, ReportContentView } from './interview-pool/InterviewPoolViews';
import { haptic } from '../../lib/telegram';

const P = (projectId: string) => `/interview-pool/projects/${projectId}`;

function useJson<T>(route: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!route) return;
    setError(null);
    domainApi.getJson(route).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
    // ОСТАВЛЕНО ОСОЗНАННО (аудит 2026-09-01, ревизия всех подавлений):
    // массив зависимостей собирается из spread — статически он для
    // правила неразрешим («React Hook has a spread element in its
    // dependency array»), и никакая перестановка зависимостей это не
    // снимает. Зависимости здесь передаёт вызывающая сторона, это
    // единственный корректный вариант для универсального useJson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, tick, ...deps]);
  return { data, error, refresh: () => setTick((t) => t + 1) };
}

interface QItem { text: string; category: string | null; orderIndex: number; isRequired: boolean }

export function QuestionnairePanel({ projectId, config }: { projectId: string; config: any }) {
  const [items, setItems] = useState<QItem[]>(() => (config.questions ?? []).map((q: any, i: number) => ({ text: q.text, category: q.category ?? null, orderIndex: i, isRequired: Boolean(q.isRequired) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function draft() {
    setBusy(true); setError(null);
    try { const d = await domainApi.postJson(`${P(projectId)}/questionnaire/generate-draft`, {}); setItems(Array.isArray(d) ? d : []); haptic('success'); }
    catch (e) { setError(e instanceof Error ? e.message : 'AI не сформировал черновик'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(null);
    try { await domainApi.postJson(`${P(projectId)}/questionnaire`, { items: items.map((q, i) => ({ ...q, orderIndex: i })) }); setSaved(true); haptic('success'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  }
  return (
    <div className="domain-panel">
      <p className="card-section__empty">AI предлагает черновик по описанию вакансии — вопросы правятся перед сохранением; сохранённый опросник становится повесткой собеседований.</p>
      {error && <p className="generation-error">{error}</p>}
      <div className="domain-criteria">
        {items.map((q, i) => (
          <div key={i} className="domain-criteria__row">
            <input value={q.text} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            <label><input type="checkbox" checked={q.isRequired} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, isRequired: e.target.checked } : x)))} /> обязательный</label>
            <button type="button" className="secondary" onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setItems([...items, { text: '', category: null, orderIndex: items.length, isRequired: false }])}>+ вопрос</button>
      </div>
      <div className="entity-form__actions">
        <button type="button" className="secondary" disabled={busy} onClick={draft}>Черновик от AI</button>
        <button type="button" className="primary" disabled={busy || items.length === 0} onClick={save}>{saved ? 'Сохранено ✓' : 'Сохранить опросник'}</button>
      </div>
    </div>
  );
}

/** Ссылка-приглашение с явным сроком жизни. Аудит 2026-09-02: раньше
 *  сервер её возвращал, а интерфейс молчал — «поделиться» выглядело
 *  выполненным, но отправить получателю было нечего. */
export function ShareLinkView({ link, expiresAt, onClose }: { link: string; expiresAt: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const until = expiresAt ? new Date(expiresAt) : null;
  return (
    <div className="domain-panel">
      <p>Ссылка на профиль — отправьте её получателю:</p>
      <pre className="domain-json">{link}</pre>
      {until && !Number.isNaN(until.getTime()) && (
        <p className="card-section__empty">Действительна до {until.toLocaleString('ru-RU')}. После этого ссылку нужно создать заново.</p>
      )}
      <div className="entity-form__actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            // clipboard может быть недоступен (нет разрешения, старый
            // WebView) — тогда ссылка всё равно видна и выделяется.
            void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false));
          }}
        >
          {copied ? 'Скопировано ✓' : 'Скопировать'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>Скрыть</button>
      </div>
    </div>
  );
}

export function CandidatesPanel({ projectId, config }: { projectId: string; config: any }) {
  const { data: statuses, error, refresh } = useJson<any[]>(`${P(projectId)}/candidates`);
  const [mode, setMode] = useState<'none' | 'new' | 'existing'>('none');
  const [openId, setOpenId] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<Record<string, any>>({});
  const [err, setErr] = useState<string | null>(null);
  const stages: any[] = config.interviewStages ?? [];

  async function addExisting(v: Record<string, unknown>) {
    await domainApi.postJson(`${P(projectId)}/candidates`, v); setMode('none'); refresh();
  }
  async function createAndAdd(v: Record<string, unknown>) {
    const profile = await domainApi.postJson('/candidate-profiles', { ...v, recruitingTeamId: config.recruitingTeamId ?? undefined });
    await domainApi.postJson(`${P(projectId)}/candidates`, { candidateProfileId: profile.id });
    setMode('none'); refresh();
  }
  const [shareLink, setShareLink] = useState<{ link: string; expiresAt: string } | null>(null);

  async function loadAgenda(candidateProfileId: string) {
    try { setAgenda((a) => ({ ...a, [candidateProfileId]: undefined })); const d = await domainApi.getJson(`${P(projectId)}/candidates/${candidateProfileId}/agenda`); setAgenda((a) => ({ ...a, [candidateProfileId]: d })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Повестка недоступна'); }
  }
  async function share(candidateProfileId: string) {
    if (!window.confirm('Подтверждаете, что кандидат дал согласие на передачу профиля в команду?')) return;
    try {
      const r = await domainApi.postJson(`/candidate-profiles/${candidateProfileId}/share`, { candidateConsentConfirmed: true });
      haptic('success');
      // Аудит 2026-09-02: ответ {deepLink, expiresAt} раньше молча
      // выбрасывался — токен создавался и тикал 72 часа, а отправить
      // ссылку было нечем: в интерфейсе она не показывалась нигде.
      setShareLink({ link: String(r.deepLink ?? ''), expiresAt: String(r.expiresAt ?? '') });
      refresh();
    }
    catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось поделиться'); }
  }

  return (
    <div className="domain-panel">
      {(error || err) && <p className="generation-error">{error ?? err}</p>}
      {statuses && statuses.length === 0 && <p className="card-section__empty">Кандидатов пока нет.</p>}
      {shareLink && <ShareLinkView link={shareLink.link} expiresAt={shareLink.expiresAt} onClose={() => setShareLink(null)} />}
      <ul className="domain-entities">
        {(statuses ?? []).map((s: any) => {
          const cp = s.candidateProfile ?? {};
          return (
            <li key={s.id} className="domain-entities__item">
              <button type="button" className="domain-entities__title" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                {cp.displayName ?? s.candidateProfileId} <span className="domain-badge">{s.currentStage ?? s.status ?? '—'}</span>
              </button>
              {openId === s.id && (
                <div className="domain-entities__body">
                  {cp.contactInfo && <p>{cp.contactInfo}</p>}
                  <div className="entity-form__actions">
                    <button type="button" className="secondary" onClick={() => loadAgenda(cp.id)}>Повестка собеседования</button>
                    <button type="button" className="secondary" onClick={() => share(cp.id)}>Поделиться с командой</button>
                  </div>
                  {agenda[cp.id] && <AgendaView questions={agenda[cp.id]} />}
                  <h4>Этапы</h4>
                  <EntityForm
                    fields={[
                      { name: 'stageDefinitionId', label: 'Этап', type: 'select', required: true, options: stages.map((st) => ({ value: st.id, label: `${st.orderIndex + 1}. ${st.name}` })) },
                      { name: 'conversationId', label: 'ID записи собеседования', type: 'text' },
                      { name: 'completedAt', label: 'Когда', type: 'datetime' },
                    ]}
                    submitLabel="Отметить этап пройденным"
                    onSubmit={async (v) => { await domainApi.postJson(`/interview-pool/pipeline-statuses/${s.id}/stage-progress`, v); refresh(); }}
                  />
                  <FollowUps statusId={s.id} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {mode === 'none' && (
        <div className="entity-form__actions">
          <button type="button" className="primary" onClick={() => setMode('new')}>+ Новый кандидат</button>
          <button type="button" className="secondary" onClick={() => setMode('existing')}>+ Из моих / командных профилей</button>
        </div>
      )}
      {mode === 'new' && <EntityForm fields={[{ name: 'displayName', label: 'Имя', type: 'text', required: true }, { name: 'contactInfo', label: 'Контакт', type: 'text' }, { name: 'resumeText', label: 'Резюме (текст)', type: 'textarea' }]} submitLabel="Создать и добавить" onSubmit={createAndAdd} onCancel={() => setMode('none')} />}
      {mode === 'existing' && <ExistingCandidatePicker onSubmit={addExisting} onCancel={() => setMode('none')} />}
    </div>
  );
}

function ExistingCandidatePicker({ onSubmit, onCancel }: { onSubmit: (v: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const { data, error } = useJson<any[]>('/candidate-profiles');
  if (error) return <p className="generation-error">{error}</p>;
  if (!data) return <p className="dtp-muted">Загрузка профилей…</p>;
  if (data.length === 0) return <p className="card-section__empty">Профилей пока нет — создайте нового кандидата или вступите в команду. <button type="button" className="secondary" onClick={onCancel}>Закрыть</button></p>;
  return (
    <EntityForm
      fields={[
        { name: 'candidateProfileId', label: 'Кандидат', type: 'select', required: true, options: data.map((c) => ({ value: c.id, label: `${c.displayName}${c.recruitingTeamId ? ' · команда' : ''}${c.contactInfo ? ` · ${c.contactInfo}` : ''}` })) },
        { name: 'reuseHistory', label: 'Учесть прошлые собеседования (если есть)', type: 'bool' },
      ]}
      submitLabel="Добавить в пул" onSubmit={onSubmit} onCancel={onCancel} />
  );
}

function FollowUps({ statusId }: { statusId: string }) {
  const { data, error, refresh } = useJson<any[]>(`/interview-pool/pipeline-statuses/${statusId}/follow-up`);
  if (error) return <p className="generation-error">{error}</p>;
  if (!data || data.length === 0) return null;
  return (
    <div style={{ width: '100%' }}>
      <h4>Что кандидат обещал прислать</h4>
      <ul className="domain-sessions__list">
        {data.map((f: any) => (
          <li key={f.id}>
            <div className="domain-sessions__head">
              <span style={f.fulfilled ? { textDecoration: 'line-through' } : undefined}>{f.requestText}</span>
              <button type="button" className="secondary" onClick={async () => { await domainApi.patchJson(`/interview-pool/pipeline-statuses/${statusId}/follow-up/${f.id}`, { fulfilled: !f.fulfilled }); refresh(); }}>{f.fulfilled ? 'вернуть' : 'получено'}</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RelevancePanel({ projectId, config }: { projectId: string; config?: any }) {
  const { data, error, refresh } = useJson<any>(`${P(projectId)}/relevance-snapshot/latest`);
  const { data: history } = useJson<any[]>(`${P(projectId)}/relevance-snapshot/history`);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <div className="domain-panel">
      <p className="card-section__empty">Насколько пул кандидатов всё ещё отвечает вакансии — снимок пересчитывается по запросу.</p>
      {error && <p className="generation-error">{error}</p>}
      <RelevanceSnapshotView snapshot={data} questions={config?.questions ?? []} />
      <div className="entity-form__actions">
        <button type="button" className="primary" disabled={busy} onClick={async () => { setBusy(true); try { await domainApi.postJson(`${P(projectId)}/relevance-snapshot/regenerate`, {}); refresh(); } finally { setBusy(false); } }}>Пересчитать</button>
        <button type="button" className="secondary" onClick={() => setShowHistory(!showHistory)}>История</button>
      </div>
      {showHistory && (history ?? []).filter((h) => h.id !== data?.id).map((h) => <RelevanceSnapshotView key={h.id} snapshot={h} questions={config?.questions ?? []} compact />)}
    </div>
  );
}

export function TeamPanel({ config }: { config: any }) {
  const [team, setTeam] = useState<any>(null);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: myTeams, refresh: refreshTeams } = useJson<any[]>('/recruiting-teams');
  const teamId = team?.id ?? config.recruitingTeamId ?? (myTeams && myTeams.length === 1 ? myTeams[0].id : undefined);
  return (
    <div className="domain-panel">
      <p className="card-section__empty">Команда рекрутеров: общий пул кандидатов и переиспользование истории собеседований. Профиль кандидата попадает в команду только после его явного согласия.</p>
      {error && <p className="generation-error">{error}</p>}
      {myTeams && myTeams.length > 0 && (
        <ul className="dtp-access-log">{myTeams.map((t) => <li key={t.id}><strong>{t.name}</strong> · {t._count?.members ?? '?'} чел. · {t.role === 'OWNER' ? 'владелец' : 'участник'}{t.id === teamId && ' · текущая'}{t.id !== teamId && <> <button type="button" className="secondary" onClick={() => setTeam(t)}>выбрать</button></>}</li>)}</ul>
      )}
      {teamId ? (
        <>
          <p>Команда: <strong>{myTeams?.find((t) => t.id === teamId)?.name ?? team?.name ?? teamId}</strong></p>
          <div className="entity-form__actions">
            <button type="button" className="secondary" onClick={async () => { try { const r = await domainApi.postJson(`/recruiting-teams/${teamId}/invite-link`, {}); setInvite({ link: String(r.deepLink ?? r.token ?? ''), expiresAt: String(r.expiresAt ?? '') }); } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка'); } }}>Ссылка-приглашение</button>
          </div>
          {/* Ревью 2026-09-02: показывали голый токен в <pre> — тот же
              компонент, что у передачи кандидата: сама ссылка, срок
              жизни и кнопка копирования. */}
          {invite && <ShareLinkView link={invite.link} expiresAt={invite.expiresAt} onClose={() => setInvite(null)} />}
          <JsonPanel title="Кандидаты команды" route={`/recruiting-teams/${teamId}/candidates`} />
        </>
      ) : (
        <>
          <EntityForm fields={[{ name: 'name', label: 'Название команды', type: 'text', required: true }]} submitLabel="Создать команду" onSubmit={async (v) => { setTeam(await domainApi.postJson('/recruiting-teams', v)); refreshTeams(); }} />
          <EntityForm fields={[{ name: 'token', label: 'Токен приглашения', type: 'text', required: true }]} submitLabel="Вступить по токену" onSubmit={async (v) => {
            const t = String(v.token);
            // Аудит 2026-09-02: joinTeam возвращает RecruitingTeamMember,
            // и setTeam(r) клал сюда id ЧЛЕНСТВА — панель дальше дёргала
            // /recruiting-teams/<memberId>/candidates и получала 404, а
            // имя команды рисовалось сырым id. Берём teamId из членства
            // и перезапрашиваем список команд.
            const r = await domainApi.postJson(`/recruiting-teams/${t}/join`, { token: t });
            setTeam({ id: r.teamId ?? r.team?.id ?? r.id, name: r.team?.name });
            refreshTeams();
          }} />
        </>
      )}
    </div>
  );
}

export function ClientReportsPanel({ projectId, questions }: { projectId: string; questions?: any[] }) {
  // Кандидаты — из pipeline проекта (раньше брались из config.candidates,
  // которого не существует → кнопки «отчёт по кандидату» никогда не показывались).
  const { data: candidatesData } = useJson<any[]>(`${P(projectId)}/candidates`);
  const candidates = candidatesData ?? [];
  const [reports, setReports] = useState<any[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<any>) { try { const r = await fn(); if (r?.id) setReports((prev) => [r, ...prev.filter((x) => x.id !== r.id)]); haptic('success'); } catch (e) { haptic('error'); setError(e instanceof Error ? e.message : 'Ошибка'); } }
  return (
    <div className="domain-panel">
      <p className="card-section__empty">Отчёт заказчику формируется AI по итогам собеседований, проверяется вами и только потом отправляется.</p>
      {error && <p className="generation-error">{error}</p>}
      <div className="entity-form__actions">
        <button type="button" className="primary" onClick={() => run(() => domainApi.postJson(`/client-reports/projects/${projectId}/summary`, {}))}>Сводный отчёт по пулу</button>
        {candidates.map((s: any) => (
          <button key={s.id} type="button" className="secondary" onClick={() => run(() => domainApi.postJson(`/client-reports/projects/${projectId}/candidate/${s.candidateProfileId}`, {}))}>Отчёт: {s.candidateProfile?.displayName ?? s.candidateProfileId}</button>
        ))}
      </div>
      {reports.map((r) => (
        <div key={r.id} className="entity-form">
          {editing[r.id] !== undefined ? (
            <>
              <textarea rows={10} value={editing[r.id]} onChange={(e) => setEditing({ ...editing, [r.id]: e.target.value })} />
              <div className="entity-form__actions">
                <button type="button" className="primary" onClick={() => {
                  let content: unknown;
                  try { content = JSON.parse(editing[r.id]); } catch { content = editing[r.id]; }
                  void run(() => domainApi.patchJson(`/client-reports/${r.id}`, { content }));
                  setEditing((p) => { const n = { ...p }; delete n[r.id]; return n; });
                }}>Сохранить правки</button>
                <button type="button" className="secondary" onClick={() => setEditing((p) => { const n = { ...p }; delete n[r.id]; return n; })}>Отмена</button>
              </div>
            </>
          ) : (
            <ReportContentView content={r.content ?? r} questions={questions ?? []} />
          )}
          <div className="entity-form__actions">
            <button type="button" className="secondary" onClick={() => setEditing({ ...editing, [r.id]: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? {}, null, 2) })}>Править текст</button>
            <button type="button" className="secondary" onClick={() => run(() => domainApi.postJson(`/client-reports/${r.id}/review`, {}))}>Проверен</button>
            <button type="button" className="primary" onClick={() => run(() => domainApi.postJson(`/client-reports/${r.id}/send`, { sentViaShare: 'telegram' }))}>Отправить</button>
          </div>
        </div>
      ))}
    </div>
  );
}
