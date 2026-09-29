'use client';

// Пункт [job-domain-v2] §7–§8.3 — хаб работодателя «Найм в компанию».
// Порядок вкладок — порядок работы: Компания (без неё проект — черновик:
// 409 COMPANY_REQUIRED на конфиг и извлечение) → Бриф → Вакансия (конфиг +
// анкета) → Лист вакансии → Текст → Кандидаты (листы, матрица, слияние,
// уведомление об AI) → Агентство (engagement, отчёты) → Офферы → Процесс.
// Честная граница домена — «не отбирает за вас»: ни одной оценки кандидата
// числом, решения принимает человек.
import { useEffect, useState } from 'react';
import { DomainManifest } from '../../../lib/domains/types';
import { employerApi, sheetsApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { CandidatesPanel, QuestionnairePanel, TeamPanel } from '../InterviewPoolWorkspace';
import { InterviewPoolOverview } from '../interview-pool/InterviewPoolOverview';
import { EmployerDossierPanel } from '../hiring/EmployerDossierPanel';
import { ClientBriefPanel, VacancyPostingPanel } from '../hiring/BriefAndPostingPanels';
import { VacancySheetPanel } from '../hiring/VacancySheetPanel';
import { CoverageMatrixPanel, EngagementsPanel, ProcessDisciplinePanel } from '../hiring/TeamPanels';
import { haptic } from '../../../lib/telegram';
import { EmployerOnboardingPanel } from './EmployerOnboardingPanel';

const TABS: Array<[string, string]> = [
  ['hub', 'Обзор'], ['company', 'Компания'], ['onboarding', 'Рассказать о вакансии'], ['brief', 'Бриф'], ['vacancy', 'Вакансия'], ['questionnaire', 'Анкета'], ['sheet', 'Лист вакансии'],
  ['posting', 'Текст вакансии'], ['candidates', 'Кандидаты'], ['matrix', 'Матрица'], ['agency', 'Агентство'], ['offers', 'Офферы'], ['process', 'Процесс'], ['team', 'Команда'],
];

function OffersPanel({ projectId }: { projectId: string }) {
  const [sheets, setSheets] = useState<any[] | null>(null);
  const [offers, setOffers] = useState<any[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    sheetsApi.list(projectId).then(async (l) => {
      const interview = l.filter((s) => s.kind === 'INTERVIEW');
      setSheets(interview);
      const all: any[] = [];
      for (const s of interview) { const full = await sheetsApi.get(s.id); for (const o of full.offers) all.push({ ...o, sheetTitle: full.title, sheetId: s.id }); }
      setOffers(all);
    }).catch(setError);
  }, [projectId, tick]);
  async function run<T>(fn: () => Promise<T>, title?: string) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); if (title) setOut({ title, data: r }); setTick((t) => t + 1); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      <p className="card-section__empty">Оффер — документ по листу кандидата: составьте его на вкладке «Оффер» листа (черновик собирается из согласованных пунктов), проверьте, сверьте с тем, что обещали на собеседованиях, и передайте кандидату копией — по его ссылке самошеринга. Отзыв помечает и копию у кандидата, и сам оффер у вас — после отзыва отправить этот документ снова нельзя, замена делается новым оффером.</p>
      {sheets && sheets.length === 0 && <p className="card-section__empty">Листов кандидатов пока нет.</p>}
      {sheets && sheets.length > 0 && offers.length === 0 && <p className="card-section__empty">Офферов пока нет — откройте лист кандидата → «Оффер».</p>}
      {offers.map((o) => (
        <div key={o.id} className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{o.sheetTitle} · {new Date(o.createdAt).toLocaleDateString('ru-RU')}</span><span className="domain-badge">{o.withdrawnAt ? 'отозван' : o.sharedAt ? 'передан кандидату' : o.reviewedAt ? 'проверен' : 'черновик'}</span></div>
          <div className="dtp-card__body">
            <pre className="script-text">{o.rawText}</pre>
            <div className="entity-form__actions">
              {!o.reviewedAt && <button type="button" className="primary" disabled={busy} onClick={() => run(() => employerApi.offerReview(o.id))}>Проверен</button>}
              <button type="button" className="secondary" disabled={busy} onClick={() => run(() => employerApi.offerPromisesCheck(o.id), 'Оффер ↔ обещания на собеседованиях')}>Сверить с обещаниями</button>
              {o.reviewedAt && !o.withdrawnAt && <button type="button" className="secondary" onClick={() => setShareFor(o.id)}>Передать кандидату</button>}
              {/* Пункт [withdraw-no-trace] 2026-09-06: результат отзыва
                  показывается человеку, а не пропадает. Раньше вызов шёл
                  без заголовка — число помеченных копий (в том числе
                  ноль, то есть «помечать было нечего») никуда не
                  доходило, и второе нажатие выглядело как первое. */}
              {o.sharedAt && !o.withdrawnAt && <button type="button" className="secondary" disabled={busy} onClick={() => { if (window.confirm('Отозвать оффер? Копия у кандидата будет помечена отозванной, а оффер — отозванным у вас; отправить его снова будет нельзя.')) void run(() => employerApi.offerWithdraw(o.id), 'Оффер отозван'); }}>Отозвать</button>}
            </div>
            {shareFor === o.id && (
              <EntityForm
                fields={[{ name: 'token', label: 'Токен ссылки самошеринга кандидата', type: 'text', required: true, hint: 'Кандидат создаёт ссылку у себя («Передать» в листе) — часть после share_' }]}
                submitLabel="Передать копию" onCancel={() => setShareFor(null)}
                onSubmit={async (v) => { await employerApi.offerShare(o.id, { token: String(v.token) }); setShareFor(null); setTick((t) => t + 1); haptic('success'); }}
              />
            )}
          </div>
        </div>
      ))}
      {out && <div className="dtp-card"><div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div><div className="dtp-card__body">{out.data?.frame && <p className="dtp-status dtp-status--warn">{out.data.frame}</p>}<JsonView data={Object.fromEntries(Object.entries(out.data ?? {}).filter(([k]) => k !== 'frame'))} /></div></div>}
    </section>
  );
}

export function EmployerHiringWorkspace({ config, manifest, projectId, conversationId = null, onConfigUpdated }: { config: any; manifest: DomainManifest; projectId: string; conversationId?: string | null; onConfigUpdated: (c: Record<string, unknown>) => void }) {
  // Пришли из квиза с готовым разговором — сразу на онбординг (ответы уже там).
  const [tab, setTab] = useState(conversationId ? 'onboarding' : 'hub');
  const [state, setState] = useState<any | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  useEffect(() => { employerApi.state(projectId).then(setState).catch(setError); }, [projectId, tick, tab]);
  const bump = () => setTick((t) => t + 1);
  const draft = state?.draft ?? !config?.jobTitle;

  return (
    <>
      <nav className="domain-tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />

      {tab === 'hub' && (
        <section className="dtp-overview">
          <p className="dtp-status dtp-status--warn">Приложение не отбирает за вас: оно собирает требования и условия в лист, сверяет с ним слова кандидатов и показывает, что обсуждено и чем подтверждено. Решения о найме принимают люди.</p>
          {state?.draft && <p className="dtp-status dtp-status--warn">{state.draftReason} — вкладка «Компания».</p>}
          {state && (
            <div className="dtp-facts">
              <div><span className="dtp-facts__label">Компания</span><strong>{state.company?.legalName ?? state.company?.domain ?? '—'}</strong></div>
              <div><span className="dtp-facts__label">Вакансия</span><strong>{state.config?.jobTitle || 'не заполнена'}</strong></div>
              <div><span className="dtp-facts__label">Вопросов анкеты</span><strong>{state.config?.questions ?? 0}</strong></div>
              <div><span className="dtp-facts__label">Брифов</span><strong>{state.briefs}</strong></div>
              <div><span className="dtp-facts__label">Лист вакансии</span><strong>{state.vacancySheet ? state.vacancySheet.status : 'не открыт'}</strong></div>
              <div><span className="dtp-facts__label">Кандидатов</span><strong>{state.candidates}</strong></div>
              <div><span className="dtp-facts__label">Агентств</span><strong>{(state.engagements ?? []).filter((e: any) => e.status === 'ACTIVE').length} активных</strong></div>
              <div><span className="dtp-facts__label">Проверенных офферов</span><strong>{state.reviewedOffers}</strong></div>
            </div>
          )}
          <p className="dtp-goal">{state?.question ?? ''}</p>
          {!draft && config?.jobTitle && <InterviewPoolOverview config={config} projectId={projectId} />}
          <p className="dtp-hint">Порядок работы: Компания → Бриф (или онбординг) → Вакансия и анкета → Лист вакансии → Текст → Кандидаты. Агентство и оффер — когда понадобятся.</p>
        </section>
      )}

      {tab === 'company' && <EmployerDossierPanel projectId={projectId} role="employer" onChanged={bump} />}
      {tab === 'onboarding' && <EmployerOnboardingPanel manifest={manifest} projectId={projectId} conversationId={conversationId} onExtracted={bump} />}
      {tab === 'brief' && <ClientBriefPanel projectId={projectId} role="employer" onChanged={bump} />}

      {tab === 'vacancy' && (
        <section className="domain-panel">
          {draft && <p className="dtp-status dtp-status--warn">Сначала укажите компанию — параметры вакансии подписываются её реквизитами.</p>}
          {editing || !config?.jobTitle ? (
            <EntityForm
              fields={manifest.configFields}
              initial={config ?? {}}
              submitLabel="Сохранить"
              onCancel={config?.jobTitle ? () => setEditing(false) : undefined}
              onSubmit={async (v) => { const c = await employerApi.updateConfig(projectId, v); onConfigUpdated({ ...config, ...c }); setEditing(false); haptic('success'); bump(); }}
            />
          ) : (
            <>
              <InterviewPoolOverview config={config} projectId={projectId} />
              <button type="button" className="secondary" onClick={() => setEditing(true)}>Править параметры</button>
            </>
          )}
        </section>
      )}
      {tab === 'questionnaire' && <QuestionnairePanel projectId={projectId} config={config} />}
      {tab === 'sheet' && <VacancySheetPanel projectId={projectId} />}
      {tab === 'posting' && <VacancyPostingPanel projectId={projectId} role="employer" onChanged={bump} />}
      {tab === 'candidates' && <CandidatesPanel projectId={projectId} config={config} employer />}
      {tab === 'matrix' && <CoverageMatrixPanel projectId={projectId} />}
      {tab === 'agency' && <EngagementsPanel projectId={projectId} role="employer" />}
      {tab === 'offers' && <OffersPanel projectId={projectId} />}
      {tab === 'process' && <ProcessDisciplinePanel projectId={projectId} role="employer" />}
      {tab === 'team' && <TeamPanel config={config} teamType="EMPLOYER" />}
      {tab === 'hub' && state && <details><summary className="dtp-muted">Состояние проекта (для отладки)</summary><JsonView data={state} /></details>}
    </>
  );
}

