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
  cvDraftedAt: string | null;
  cvReviewedAt: string | null;
  criteria: Criterion[];
}

interface Vacancy {
  id: string;
  sourceUrl: string;
  siteHost: string;
  title: string | null;
  locationMatch: 'MATCHES' | 'DIFFERENT' | 'UNKNOWN' | null;
  salaryMentioned: string | null;
  matchBreakdown: Array<{ criterionId: string; coverage: string; note?: string }> | null;
  matchNotes: string | null;
  matchedAt: string | null;
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
  { key: 'stats', label: 'Статистика' },
];

function VacancyCard({ v, criteria, onChanged }: { v: Vacancy; criteria: Criterion[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const criterionText = (id: string) => criteria.find((c) => c.id === id)?.text ?? id;

  async function match() {
    setBusy(true);
    setError(null);
    try {
      await domainApi.postJson(`/job-search/vacancies/${v.id}/match`, {});
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сверить вакансию');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dtp-card">
      <button type="button" className="dtp-card__head" onClick={() => setOpen(!open)}>
        <span>
          <strong>{v.title ?? v.sourceUrl}</strong>
          <span className="dtp-muted"> · {v.siteHost}</span>
        </span>
        <span className="domain-badge">{v.matchedAt ? 'сверена' : 'без сверки'}</span>
      </button>
      {open && (
        <div className="dtp-card__body">
          {error && <p className="generation-error">{error}</p>}
          <p>
            <a href={v.sourceUrl} target="_blank" rel="noreferrer">{v.sourceUrl}</a>
          </p>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      onConfigUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
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
          {error && <p className="generation-error">{error}</p>}
          <p className="card-section__empty">
            Резюме составляет AI по вашему рассказу на онбординге. Пока вы его не утвердили — это черновик;
            повторная генерация снимает утверждение.
          </p>
          {config.cvText ? (
            <>
              <p className="dtp-muted">
                Черновик от {config.cvDraftedAt ? new Date(config.cvDraftedAt).toLocaleString() : '—'}
                {config.cvReviewedAt ? ` · утверждено ${new Date(config.cvReviewedAt).toLocaleString()}` : ' · не утверждено'}
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
          {vacError && <p className="generation-error">{vacError}</p>}
          <p className="card-section__empty">
            Добавьте ссылку на вакансию — текст страницы сохраняется как есть, без пересказа. Сверка с резюме —
            отдельным действием по каждой вакансии.
          </p>
          {vacancies?.length === 0 && <p className="card-section__empty">Вакансий пока нет.</p>}
          {vacancies?.map((v) => <VacancyCard key={v.id} v={v} criteria={config.criteria} onChanged={bump} />)}
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

      {tab === 'stats' && (
        <section className="domain-panel">
          {statsError && <p className="generation-error">{statsError}</p>}
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
