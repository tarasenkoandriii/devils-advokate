'use client';

// ТЗ §0 — DomainConfigView: проект домена. Нет конфига → DomainOnboarding;
// есть → цель/критерии + вкладки сущностей (EntityPanel) и extras
// (comparison-table / budget / json-панели). Всё из манифеста.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { getManifest } from '../../../../lib/domains/manifests';
import { domainApi } from '../../../../lib/domains/api';
import { DomainOnboarding } from '../../../../components/domains/DomainOnboarding';
import { EntityPanel } from '../../../../components/domains/EntityPanel';
import { BudgetPanel } from '../../../../components/domains/BudgetPanel';
import { JsonPanel, JsonView } from '../../../../components/domains/JsonPanel';
import { useBackButton } from '../../../../hooks/useBackButton';
import { CandidatesPanel, ClientReportsPanel, QuestionnairePanel, RelevancePanel, TeamPanel } from '../../../../components/domains/InterviewPoolWorkspace';
import { ShareAllPanel } from '../../../../components/domains/DomainExtrasManual';
import { DtpWorkspace } from '../../../../components/domains/dtp/DtpWorkspace';
import { FamilyLawWorkspace } from '../../../../components/domains/family-law/FamilyLawWorkspace';
import { HealthWorkspace } from '../../../../components/domains/health/HealthWorkspace';
import { MajorPurchaseWorkspace } from '../../../../components/domains/major-purchase/MajorPurchaseWorkspace';
import { InvestmentWorkspace } from '../../../../components/domains/investment/InvestmentWorkspace';
import { InterviewPoolOverview } from '../../../../components/domains/interview-pool/InterviewPoolOverview';
import { LiveHintsSession } from '../../../../components/LiveHintsSession';

export default function DomainProjectPage() {
  const params = useParams<{ domain: string; projectId: string }>();
  const router = useRouter();
  const manifest = getManifest(params.domain);
  const [config, setConfig] = useState<Record<string, any> | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('overview');
  useBackButton(() => router.push(`/domains/${params.domain}`));

  useEffect(() => {
    if (!manifest) return;
    domainApi.getConfig(manifest, params.projectId)
      .then((c) => setConfig(c ?? null))
      .catch((e) => {
        // 404 «конфига ещё нет» — нормальное состояние до онбординга, не ошибка
        if (e && typeof e === 'object' && 'httpStatus' in e && (e as any).httpStatus === 404) setConfig(null);
        else setError(e instanceof Error ? e.message : 'Не удалось загрузить');
      });
  }, [manifest, params.projectId]);

  if (!manifest) return <main className="page"><p className="generation-error">Неизвестный сценарий.</p></main>;
  if (error) return <main className="page"><p className="generation-error">{error}</p></main>;
  if (config === undefined) return <main className="page"><p>Загрузка…</p></main>;

  if (config === null) {
    return (
      <main className="page">
        <p><Link href={`/domains/${manifest.id}`}>← {manifest.title}</Link></p>
        <DomainOnboarding manifest={manifest} projectId={params.projectId} conversationId={null} onConfigCreated={(c) => { setConfig(c); setTab('overview'); }} />
      </main>
    );
  }

  const configId: string = config.id;

  // Доменная вёрстка (ТЗ §5): dtp — образец, family-law и health — на общих
  // компонентах shared/ConsultationPipeline. Остальные — generic-вкладки.
  const domainWorkspace =
    manifest.id === 'dtp' ? <DtpWorkspace config={config as any} manifest={manifest} />
    : manifest.id === 'family-law' ? <FamilyLawWorkspace config={config as any} manifest={manifest} onConfigUpdated={setConfig} />
    : manifest.id === 'health' ? <HealthWorkspace config={config as any} manifest={manifest} />
    : manifest.id === 'major-purchase' ? <MajorPurchaseWorkspace config={config as any} manifest={manifest} />
    : manifest.id === 'investment' ? <InvestmentWorkspace config={config as any} manifest={manifest} projectId={params.projectId} />
    : null;
  if (domainWorkspace) {
    return (
      <main className="page">
        <p><Link href={`/domains/${manifest.id}`}>← {manifest.title}</Link></p>
        <h1>{manifest.icon} {manifest.title}</h1>
        {domainWorkspace}
      </main>
    );
  }
  // Ручные панели (ТЗ §0, фаза C) — только для interview-pool: остальные домены
  // ушли на доменные workspace выше и сюда не доходят.
  const manualTabs: Array<{ key: string; label: string; render: () => JSX.Element }> = [];
  if (manifest.id === 'interview-pool') {
    manualTabs.push(
      { key: 'm:questionnaire', label: 'Опросник', render: () => <QuestionnairePanel projectId={params.projectId} config={config} /> },
      { key: 'm:candidates', label: 'Кандидаты', render: () => <CandidatesPanel projectId={params.projectId} config={config} /> },
      { key: 'm:relevance', label: 'Релевантность', render: () => <RelevancePanel projectId={params.projectId} config={config} /> },
      { key: 'm:team', label: 'Команда', render: () => <TeamPanel config={config} /> },
      { key: 'm:reports', label: 'Отчёты', render: () => <ClientReportsPanel projectId={params.projectId} questions={config.questions ?? []} /> },
      { key: 'm:live', label: 'Live на собеседовании', render: () => <div className="dtp-section"><p className="dtp-hint">Во время собеседования: подсказывает следующий ещё не заданный вопрос опросника по живому транскрипту. Кандидат должен знать о записи — согласие спрашивается перед стартом.</p><LiveHintsSession projectId={params.projectId} mode="interview" /></div> },
    );
  }
  if (manifest.id === 'interview-pool') manualTabs.push({ key: 'm:share', label: 'Передача заказчику', render: () => <ShareAllPanel projectId={params.projectId} /> });

  const tabs = [
    { key: 'overview', label: 'Обзор' },
    ...manifest.entities.map((e) => ({ key: `e:${e.key}`, label: e.label })),
    ...manualTabs.map((m) => ({ key: m.key, label: m.label })),
    ...manifest.extras.filter((x) => !(manifest.id === 'interview-pool' && x.key === 'compliance')).map((x) => ({ key: `x:${x.key}`, label: x.label })),
  ];

  return (
    <main className="page">
      <p><Link href={`/domains/${manifest.id}`}>← {manifest.title}</Link></p>
      <h1>{manifest.icon} {config.goalDescription ?? config.jobTitle ?? manifest.title}</h1>
      <nav className="domain-tabs">
        {tabs.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>

      {tab === 'overview' && (manifest.id === 'interview-pool'
        ? <InterviewPoolOverview config={config as any} projectId={params.projectId} />
        : <section className="domain-panel"><JsonView data={Object.fromEntries(Object.entries(config).filter(([k]) => !/^(id|.*Id|createdAt|updatedAt)$/.test(k)))} /></section>)}
      {manifest.entities.map((e) => tab === `e:${e.key}` && <EntityPanel key={e.key} spec={e} configId={configId} />)}
      {manualTabs.map((m) => tab === m.key && <div key={m.key}>{m.render()}</div>)}
      {manifest.extras.map((x) => {
        if (tab !== `x:${x.key}`) return null;
        if (x.kind === 'budget') return <BudgetPanel key={x.key} spec={x} configId={configId} />;
        const route = x.projectRoute ? x.projectRoute(params.projectId) : x.route(configId);
        return <JsonPanel key={x.key} route={route} />;
      })}
    </main>
  );
}
