'use client';

// Доменная вёрстка «Поиск работы» — повторный аудит 2026-09-01.
//
// До неё домен существовал только на бэкенде: intake-квиз мог отправить
// пользователя в `job-search`, проект создавался, а страница отвечала
// «Неизвестный сценарий» — данные создавались и становились
// недостижимыми. Здесь тот же приём, что у investment/major-purchase:
// generic-компоненты не подходят (вакансии висят на ПРОЕКТЕ, а не на
// конфиге, и generic EntityPanel параметризуется configId).
//
// Границы, которые держит бэкенд и повторяет этот экран: никакого
// score/rank и никакого «подходит/не подходит» — только покрытие ваших
// критериев по каждой вакансии и нейтральные заметки; CV генерирует AI,
// утверждает человек отдельным действием.
import { useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { EntityForm } from '../EntityForm';
import { money } from '../dtp/dtp-types';
import { CriteriaByCategory, Criterion, useList, useOne } from '../shared/ConsultationPipeline';
import { AiErrorNotice } from '../AiErrorNotice';
import { JsonView } from '../JsonPanel';
import { cvImportApi, intakeApi, sheetsApi, Sheet } from '../../../lib/hiring/api';
import { TermsSheetView, useOpenSheet } from '../hiring/TermsSheetView';
import { CandidateSheetTools } from '../hiring/CandidateSheetTools';
import { IntakePanel } from '../hiring/IntakePanel';
import { JobSearchToolsPanel } from '../hiring/JobSearchToolsPanel';
import { EmployerDossierPanel } from '../hiring/EmployerDossierPanel';

interface JobSearchConfig {
  id: string;
  desiredRole: string;
  city: string | null;
  region: string | null;
  salaryExpectation: number | null;
  currency: string | null;
  employmentFormat: string | null;
  experienceSummary: string | null;
  cvText: string | null;
  cvDraft: unknown | null;
  cvDraftEvidence: { sourceRef: string | null; importedAt: string; items: Array<{ path: string; quote: string }> } | null;
  cvDraftedAt: string | null;
  cvReviewedAt: string | null;
  criteria: Criterion[];
}

interface Vacancy {
  id: string;
  sourceUrl: string | null;
  siteHost: string | null;
  title: string | null;
  // Пункт [job-domain-v2] связка П
  intakeSource?: string;
  favorite?: boolean;
  watchEnabled?: boolean;
  duplicateOfId?: string | null;
  responseStatus?: string | null;
  employerDossierId?: string | null;
  locationMatch: 'MATCHES' | 'DIFFERENT' | 'UNKNOWN' | null;
  salaryMentioned: string | null;
  matchBreakdown: Array<{ criterionId: string; coverage: string; note?: string }> | null;
  matchNotes: string | null;
  matchedAt: string | null;
  // Пункт [state-not-sent] 2026-09-06: состояние источника приходит
  // колонкой, а не подстрокой в тексте вакансии.
  removedFromSourceAt?: string | null;
  lastRefetchedAt?: string | null;
  /** Пункт [stored-text-cut] 2026-09-06: длина текста ДО обрезки по
   * потолку хранения. */
  rawTextTotalChars?: number | null;
}

/** Пункт [stored-text-cut] 2026-09-06 — если текст вакансии вошёл в
 * продукт не целиком, человек узнаёт об этом здесь, а не догадывается
 * по обрыву на полуслове. Валидатор запроса пропускает 20 000 знаков,
 * хранение режет до 12 000, и раньше об этом не говорилось нигде —
 * при том что по этому обрезку идут и сверка с CV, и признаки
 * мошенничества, и склейка дублей. */
const VACANCY_TEXT_LIMIT = 12_000;

function IntakeNote({ v }: { v: Vacancy }) {
  const total = v.rawTextTotalChars ?? null;
  if (total === null || total <= VACANCY_TEXT_LIMIT) return null;
  return (
    <p className="dtp-status dtp-status--warn">
      В продукт вошли первые {VACANCY_TEXT_LIMIT.toLocaleString('ru-RU')} знаков из {total.toLocaleString('ru-RU')} —
      конец текста не сохранён. Сверка с CV, признаки мошенничества и поиск дублей идут по вошедшей части.
    </p>
  );
}

/** Пункт [state-not-sent] 2026-09-06 — снятие с публикации говорится
 * вслух. Раньше факт снятия существовал только внутри текста вакансии,
 * а текста в списке нет: человек видел снятую вакансию как обычную,
 * открывал по ней лист условий и запускал сверку с CV.
 *
 * Формулировка намеренно не объявляет место занятым: объявления
 * снимают и переписывают, снимают при наборе паузы, снимают и
 * возвращают. Продукт сообщает наблюдаемое — источник перестал
 * отвечать — и не достраивает из этого вывод о найме. */
function AvailabilityNote({ v }: { v: Vacancy }) {
  if (v.removedFromSourceAt) {
    return (
      <p className="dtp-status dtp-status--warn">
        Источник перестал отвечать {new Date(v.removedFromSourceAt).toLocaleDateString('ru-RU')} (404). Текст
        сохранён таким, каким был. Снятие с публикации не всегда значит, что место занято: объявления снимают,
        переписывают и возвращают.
      </p>
    );
  }
  if (v.sourceUrl && v.lastRefetchedAt === null) {
    return <p className="dtp-muted">Источник не перечитывался ни разу — на месте ли вакансия сейчас, сказать нельзя.</p>;
  }
  return null;
}

interface Statistics {
  total: number;
  matched: number;
  bySite: Record<string, number>;
  byLocationMatch: Record<string, number>;
  withSalaryMentioned: number;
  requiredCriteriaCount: number;
  fullRequiredCoverage: number;
  city: string | null;
  region: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  ROLE_FIT: 'Роль и опыт',
  COMPENSATION: 'Деньги',
  LOCATION: 'Город и формат',
  CONDITIONS: 'Условия',
  OTHER: 'Прочее',
};

const COVERAGE_LABEL: Record<string, string> = {
  covered: 'есть в вакансии',
  partial: 'частично',
  not_covered: 'нет в вакансии',
  unknown: 'не сказано',
};

const LOCATION_LABEL: Record<string, string> = {
  MATCHES: 'совпадает с вашим городом',
  DIFFERENT: 'другой город/регион',
  UNKNOWN: 'не указан',
  NOT_MATCHED_YET: 'ещё не сверялась',
};

const TABS = [
  { key: 'overview', label: 'Обзор' },
  { key: 'cv', label: 'Резюме' },
  { key: 'vacancies', label: 'Вакансии' },
  // Пункт [job-domain-v2]: приток вакансий (связка П), инструменты над всеми
  // вакансиями, компания-работодатель как объект досье.
  { key: 'intake', label: 'Приток' },
  { key: 'tools', label: 'Инструменты' },
  { key: 'company', label: 'Компания' },
  { key: 'stats', label: 'Статистика' },
];

const RESPONSE_LABEL: Record<string, string> = { APPLIED: 'откликнулись', VIEWED: 'просмотрено', INTERVIEW: 'собеседование', OFFER: 'оффер', REJECTED: 'отказ', WITHDRAWN: 'отозвали' };

/** Лист условий по вакансии (VACANCY_RESPONSE): ваши критерии ↔ требования
 * вакансии, CV-вариант, самошеринг, подготовка. Открывается по вакансии один
 * раз — дальше возобновляется. */
function VacancySheetLauncher({ vacancyId, projectId }: { vacancyId: string; projectId: string }) {
  const { sheetId, setSheetId, error, busy, open } = useOpenSheet();
  if (sheetId) {
    return (
      <div className="dtp-section">
        <button type="button" className="secondary" onClick={() => setSheetId(null)}>Свернуть лист условий</button>
        <TermsSheetView
          sheetId={sheetId}
          role="candidate"
          intro={<p className="card-section__empty">Слева — что требует и предлагает работодатель (из текста вакансии, AI-черновики ждут вашего подтверждения), справа — ваши критерии. Позиция появляется только с цитатой-опорой; оценок «подходите / не подходите» здесь нет.</p>}
          extras={(sheet: Sheet, refresh) => <CandidateSheetTools sheet={sheet} projectId={projectId} refresh={refresh} />}
        />
      </div>
    );
  }
  return (
    <div>
      <AiErrorNotice error={error} onConsentGranted={() => undefined} />
      <button type="button" className="primary" disabled={busy} onClick={() => open(() => sheetsApi.openForVacancy(vacancyId))}>{busy ? 'Открываем…' : 'Лист условий по вакансии'}</button>
    </div>
  );
}

function VacancyCard({ v, criteria, projectId, onChanged }: { v: Vacancy; criteria: Criterion[]; projectId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<{ title: string; data: any } | null>(null);
  async function tool<T>(fn: () => Promise<T>, title?: string) {
    setBusy(true); setError(null);
    try { const r = await fn(); if (title) setExtra({ title, data: r }); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  // Пункт [ai-errors-ui] 2026-09-02: храним САМУ ошибку, а не текст —
  // по httpStatus 403 экран показывает согласие вместо служебной
  // строки «Consent required: EXTERNAL_AI (userId=…)».
  const [error, setError] = useState<unknown>(null);
  const criterionText = (id: string) => criteria.find((c) => c.id === id)?.text ?? id;

  async function match() {
    setBusy(true);
    setError(null);
    try {
      await domainApi.postJson(`/job-search/vacancies/${v.id}/match`, {});
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dtp-card">
      <button type="button" className="dtp-card__head" onClick={() => setOpen(!open)}>
        <span>
          <strong>{v.favorite ? '★ ' : ''}{v.title ?? v.sourceUrl ?? 'без названия'}</strong>
          <span className="dtp-muted"> · {v.siteHost ?? 'без ссылки'}</span>
          {v.responseStatus && <span className="dtp-muted"> · {RESPONSE_LABEL[v.responseStatus] ?? v.responseStatus}</span>}
        </span>
        {/* [state-not-sent] 2026-09-06: снятие с публикации — первое, что
            нужно знать о вакансии, поэтому оно и стоит первым. */}
        <span className="domain-badge">{v.removedFromSourceAt ? 'снята с публикации' : v.duplicateOfId ? 'дубликат' : v.matchedAt ? 'сверена' : 'без сверки'}</span>
      </button>
      {open && (
        <div className="dtp-card__body">
          <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
          <AvailabilityNote v={v} />
          <IntakeNote v={v} />
          {v.sourceUrl && (
            <p>
              <a href={v.sourceUrl} target="_blank" rel="noreferrer">{v.sourceUrl}</a>
            </p>
          )}
          <p className="dtp-muted">
            Город: {LOCATION_LABEL[v.locationMatch ?? 'NOT_MATCHED_YET']}
            {' · '}
            Зарплата: {v.salaryMentioned ? `названа — «${v.salaryMentioned}»` : 'в тексте не названа'}
          </p>

          {v.matchedAt ? (
            <>
              <h4>Покрытие ваших критериев</h4>
              {(v.matchBreakdown ?? []).length === 0 && <p className="dtp-muted">Разбор пуст.</p>}
              <ul>
                {(v.matchBreakdown ?? []).map((b, i) => (
                  <li key={`${b.criterionId}-${i}`}>
                    <strong>{criterionText(b.criterionId)}</strong> — {COVERAGE_LABEL[b.coverage] ?? b.coverage}
                    {b.note && <span className="dtp-muted"> · {b.note}</span>}
                  </li>
                ))}
              </ul>
              {v.matchNotes && <p className="dtp-hint">{v.matchNotes}</p>}
              <button type="button" className="secondary" disabled={busy} onClick={match}>
                {busy ? 'Сверяем…' : 'Сверить заново'}
              </button>
            </>
          ) : (
            <>
              <p className="dtp-muted">Сверка сравнит текст вакансии с вашим резюме и критериями. Нужно сгенерированное резюме.</p>
              <button type="button" className="primary" disabled={busy} onClick={match}>
                {busy ? 'Сверяем…' : 'Сверить с резюме'}
              </button>
            </>
          )}

          <h4>Лист условий</h4>
          <VacancySheetLauncher vacancyId={v.id} projectId={projectId} />

          <div className="entity-form__actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.favorite(v.id, !v.favorite))}>{v.favorite ? 'Убрать из избранного' : 'В избранное'}</button>
            {/* К-3 (аудит 2026-09-03): отметка отклика руками — иначе «молчат
                N дней» пусто у всех, кто не выгружает историю с площадки. */}
            <select
              value={v.responseStatus ?? ''}
              disabled={busy}
              onChange={(e) => tool(() => intakeApi.responseStatus(v.id, e.target.value || null))}
              aria-label="Статус отклика"
            >
              <option value="">отклика не было</option>
              {Object.entries(RESPONSE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {v.sourceUrl && <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.watch(v.id, !v.watchEnabled))}>{v.watchEnabled ? 'Не следить' : 'Следить за изменениями'}</button>}
            {v.sourceUrl && <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.refetch(v.id), 'Перечитать вакансию')}>Перечитать</button>}
            <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.changes(v.id), 'История изменений текста')}>Изменения</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.scamSignals(v.id), 'Признаки, на которые стоит посмотреть')}>Признаки мошенничества</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.similar(projectId, v.id), 'Похожие по словам вакансии')}>Похожие</button>
            {v.duplicateOfId && <button type="button" className="secondary" disabled={busy} onClick={() => tool(() => intakeApi.unlinkDuplicate(v.id))}>Это не дубликат</button>}
          </div>
          {extra && (
            <div className="dtp-card">
              <div className="dtp-card__head dtp-card__head--static"><span>{extra.title}</span><button type="button" className="dtp-link" onClick={() => setExtra(null)}>скрыть</button></div>
              <div className="dtp-card__body">
                {extra.data?.frame && <p className="dtp-status dtp-status--warn">{extra.data.frame}</p>}
                {Array.isArray(extra.data?.signals) ? (
                  extra.data.signals.length === 0 ? <p className="card-section__empty">Признаков не найдено — это не гарантия, а отсутствие совпадений с известными шаблонами.</p>
                  : <ul>{extra.data.signals.map((sg: any, i: number) => <li key={i}><strong>{sg.kind ?? sg.category}</strong>{sg.quote ? <>: «{sg.quote}»</> : null}{sg.note ? <span className="dtp-muted"> · {sg.note}</span> : null}</li>)}</ul>
                ) : <JsonView data={Object.fromEntries(Object.entries(extra.data ?? {}).filter(([k]) => k !== 'frame'))} />}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function JobSearchWorkspace({
  config,
  projectId,
  onConfigUpdated,
}: {
  config: JobSearchConfig;
  manifest: DomainManifest;
  projectId: string;
  onConfigUpdated: (c: Record<string, unknown>) => void;
}) {
  const [tab, setTab] = useState('overview');
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ missing: Array<{ path: string; label: string }>; note: string; evidenceCount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Пункт [ai-errors-ui] 2026-09-02: храним САМУ ошибку, а не текст —
  // по httpStatus 403 экран показывает согласие вместо служебной
  // строки «Consent required: EXTERNAL_AI (userId=…)».
  const [error, setError] = useState<unknown>(null);
  const bump = () => setTick((t) => t + 1);

  const { data: vacancies, error: vacError } = useList<Vacancy>(
    tab === 'vacancies' ? `/job-search/projects/${projectId}/vacancies` : null,
    tick,
  );
  const { data: stats, error: statsError } = useOne<Statistics>(
    tab === 'stats' ? `/job-search/projects/${projectId}/statistics` : null,
    tick,
  );

  async function cvAction(kind: 'draft' | 'review') {
    setBusy(true);
    setError(null);
    try {
      const updated = await domainApi.postJson(`/job-search/projects/${projectId}/cv/${kind}`, {});
      // МЕРДЖ, а не замена (аудит 2026-09-02). Ответ эндпоинта — тот же
      // конфиг, но замена целиком означала: любое поле, которого в нём
      // не окажется, исчезает из состояния экрана. Так и было с
      // критериями — «Обзор» после генерации CV писал «критериев нет», а
      // раскрытие свёренной вакансии падало на criteria.find(). Сервер
      // теперь отдаёт критерии, но полагаться на форму ответа целиком —
      // ровно та же ошибка. Так же сделано в family-law.
      onConfigUpdated({ ...config, ...(updated as Record<string, unknown>) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="domain-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <section className="dtp-overview">
          <p className="dtp-status dtp-status--warn">
            Приложение не оценивает, «подходит» ли вам вакансия, и не ранжирует их. Оно показывает, что из ваших
            критериев в вакансии названо, а что нет — вывод делаете вы.
          </p>
          <div className="dtp-facts">
            <div><span className="dtp-facts__label">Роль</span><strong>{config.desiredRole}</strong></div>
            <div><span className="dtp-facts__label">Где</span><strong>{[config.city, config.region].filter(Boolean).join(', ') || '—'}</strong></div>
            <div><span className="dtp-facts__label">Ожидания</span><strong>{money(config.salaryExpectation, config.currency)}</strong></div>
            <div><span className="dtp-facts__label">Формат</span><strong>{config.employmentFormat ?? '—'}</strong></div>
          </div>
          {config.experienceSummary && <p className="dtp-goal">{config.experienceSummary}</p>}
          <h3>Критерии</h3>
          <CriteriaByCategory criteria={config.criteria} labels={CATEGORY_LABEL} />
        </section>
      )}

      {tab === 'cv' && (
        <section className="domain-panel">
          <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
          <p className="card-section__empty">
            Резюме можно собрать двумя путями: из вашего рассказа на онбординге или из уже готового документа.
            И там, и там это черновик, пока вы его не утвердили; повторная сборка снимает утверждение.
          </p>

          {/* Пункт [job-domain-v2] К-22 (аудит 2026-09-03) — импорт готового
              резюме. Каждый элемент обязан опираться на дословную цитату из
              документа: то, что «дописал» разбор, видно списком и не даёт
              утвердить CV. */}
          {importing ? (
            <EntityForm
              fields={[
                { name: 'text', label: 'Текст вашего резюме', type: 'textarea', required: true, hint: 'Скопируйте из файла как есть — форматирование не важно' },
                { name: 'sourceRef', label: 'Откуда (файл, письмо)', type: 'text' },
              ]}
              submitLabel="Импортировать"
              onCancel={() => setImporting(false)}
              onSubmit={async (v) => {
                const r = await cvImportApi.importCv(projectId, v as any);
                onConfigUpdated({ ...config, ...(r.config as Record<string, unknown>) });
                setImportResult({ missing: r.missing, note: r.note, evidenceCount: r.evidenceCount });
                setImporting(false);
              }}
            />
          ) : (
            <button type="button" className="secondary" onClick={() => setImporting(true)}>Импортировать готовое резюме</button>
          )}
          {importResult && (
            <div className="dtp-card">
              <div className="dtp-card__head dtp-card__head--static">
                <span>Разбор документа: опор — {importResult.evidenceCount}</span>
                <button type="button" className="dtp-link" onClick={() => setImportResult(null)}>скрыть</button>
              </div>
              <div className="dtp-card__body">
                <p className={importResult.missing.length ? 'dtp-status dtp-status--warn' : 'dtp-status dtp-status--ok'}>{importResult.note}</p>
                {importResult.missing.length > 0 && (
                  <ul>{importResult.missing.map((m) => <li key={m.path}>{m.label}</li>)}</ul>
                )}
              </div>
            </div>
          )}
          {config.cvDraftEvidence && (
            <p className="dtp-muted">
              Черновик импортирован{config.cvDraftEvidence.sourceRef ? ` из «${config.cvDraftEvidence.sourceRef}»` : ''}: {config.cvDraftEvidence.items.length} элементов опираются на цитаты из документа.
              Утвердить можно, только когда опора есть у каждого.
            </p>
          )}
          {config.cvText ? (
            <>
              <p className="dtp-muted">
                Черновик от {config.cvDraftedAt ? new Date(config.cvDraftedAt).toLocaleString('ru-RU') : '—'}
                {config.cvReviewedAt ? ` · утверждено ${new Date(config.cvReviewedAt).toLocaleString('ru-RU')}` : ' · не утверждено'}
              </p>
              <pre className="script-text">{config.cvText}</pre>
            </>
          ) : (
            <p className="card-section__empty">Резюме ещё не сгенерировано.</p>
          )}
          <div className="entity-form__actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void cvAction('draft')}>
              {busy ? '…' : config.cvText ? 'Сгенерировать заново' : 'Сгенерировать резюме'}
            </button>
            {config.cvText && !config.cvReviewedAt && (
              <button type="button" className="secondary" disabled={busy} onClick={() => void cvAction('review')}>
                Утвердить
              </button>
            )}
          </div>
        </section>
      )}

      {tab === 'vacancies' && (
        <section className="domain-panel">
          <AiErrorNotice error={vacError} />
          <p className="card-section__empty">
            Добавьте ссылку на вакансию — текст страницы сохраняется как есть, без пересказа. Сверка с резюме —
            отдельным действием по каждой вакансии.
          </p>
          {vacancies?.length === 0 && <p className="card-section__empty">Вакансий пока нет.</p>}
          {vacancies?.map((v) => <VacancyCard key={v.id} v={v} criteria={config.criteria} projectId={projectId} onChanged={bump} />)}
          {adding ? (
            <EntityForm
              fields={[{ name: 'sourceUrl', label: 'Ссылка на вакансию', type: 'url', required: true }]}
              submitLabel="Добавить"
              onCancel={() => setAdding(false)}
              onSubmit={async (v) => {
                await domainApi.postJson(`/job-search/projects/${projectId}/vacancies`, v);
                setAdding(false);
                bump();
              }}
            />
          ) : (
            <button type="button" className="secondary" onClick={() => setAdding(true)}>+ Вакансия</button>
          )}
        </section>
      )}

      {tab === 'intake' && <IntakePanel projectId={projectId} onChanged={bump} />}
      {tab === 'tools' && <JobSearchToolsPanel projectId={projectId} onChanged={bump} />}
      {tab === 'company' && <EmployerDossierPanel projectId={projectId} role="candidate" />}

      {tab === 'stats' && (
        <section className="domain-panel">
          <AiErrorNotice error={statsError} />
          {!stats && !statsError && <p className="card-section__empty">Загрузка…</p>}
          {stats && (
            <>
              <div className="dtp-facts">
                <div><span className="dtp-facts__label">Вакансий</span><strong>{stats.total}</strong></div>
                <div><span className="dtp-facts__label">Сверено</span><strong>{stats.matched}</strong></div>
                <div><span className="dtp-facts__label">С названной зарплатой</span><strong>{stats.withSalaryMentioned}</strong></div>
                <div>
                  <span className="dtp-facts__label">Все обязательные критерии закрыты</span>
                  <strong>{stats.requiredCriteriaCount > 0 ? stats.fullRequiredCoverage : '—'}</strong>
                </div>
              </div>
              <h3>По сайтам</h3>
              {Object.keys(stats.bySite).length === 0 ? (
                <p className="card-section__empty">Пока не из чего считать.</p>
              ) : (
                <ul>
                  {Object.entries(stats.bySite).sort((a, b) => b[1] - a[1]).map(([host, n]) => (
                    <li key={host}>{host} — {n}</li>
                  ))}
                </ul>
              )}
              <h3>По городу</h3>
              <ul>
                {Object.entries(stats.byLocationMatch).map(([k, n]) => (
                  <li key={k}>{LOCATION_LABEL[k] ?? k} — {n}</li>
                ))}
              </ul>
              <p className="dtp-hint">
                Это счётчики того, что вы сами добавили, а не рынок труда: по нескольким вакансиям выводов о зарплатах
                в городе делать нельзя.
              </p>
            </>
          )}
        </section>
      )}
    </>
  );
}
