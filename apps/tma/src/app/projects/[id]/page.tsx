'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getProjectDetail, generateArguments } from '../../../lib/features';
import { ProjectDetail } from '../../../lib/types';
import { ArgumentsList } from '../../../components/ArgumentsList';
import { ShareButton } from '../../../components/ShareButton';
import { DecisionObjectiveForm } from '../../../components/DecisionObjectiveForm';
import { NegotiationBoundariesForm } from '../../../components/NegotiationBoundariesForm';
import { PeopleSection } from '../../../components/PeopleSection';
import { ConversationsSection } from '../../../components/ConversationsSection';
import { ChatImportSection } from '../../../components/ChatImportSection';
import { ProtocolSection } from '../../../components/ProtocolSection';
import { SituationalContentSection } from '../../../components/SituationalContentSection';
import { CommitmentsSection } from '../../../components/CommitmentsSection';
import { MissingInformationSection } from '../../../components/MissingInformationSection';
import { EvidenceGapSection } from '../../../components/EvidenceGapSection';
import { OpenLoopsSection } from '../../../components/OpenLoopsSection';
import { PredictionsSection } from '../../../components/PredictionsSection';
import { ArchetypePerspectivesSection } from '../../../components/ArchetypePerspectivesSection';
import { StakeholderMapSection } from '../../../components/StakeholderMapSection';
import { OutcomeScenariosSection } from '../../../components/OutcomeScenariosSection';
import { ReconciliationArgumentsSection } from '../../../components/ReconciliationArgumentsSection';
import { SchedulerSection } from '../../../components/SchedulerSection';
import { DecisionOutcomeSection } from '../../../components/DecisionOutcomeSection';
import { ClosingMessageSection } from '../../../components/ClosingMessageSection';
import { ProjectLogSection } from '../../../components/ProjectLogSection';
import { SparringSection } from '../../../components/SparringSection';
import { WorkingMaterialsSection } from '../../../components/WorkingMaterialsSection';
import { PublicDiscussionSection } from '../../../components/PublicDiscussionSection';
import { LibrarySubmitSection } from '../../../components/LibrarySubmitSection';
import { AgendaSection } from '../../../components/AgendaSection';
import { ProtectedNotesSection } from '../../../components/ProtectedNotesSection';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const { isTelegramAvailable } = useBackButton(() => router.push('/projects'));

  function loadProject(id: string) {
    return getProjectDetail(id)
      .then(setProject)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить проект'));
  }

  useEffect(() => {
    if (!params.id) return;
    void loadProject(params.id).finally(() => setLoading(false));

  }, [params.id]);

  // MVP-фича 6: после сохранения цели разговора — предложить
  // перегенерировать аргументы с её учётом (ArgumentGenerationService
  // уже подмешивает DecisionObjective в промпт, см. buildUserPrompt).
  // Не автоматически — пользователь решает, тратить ли новый AI-вызов.
  async function handleRegenerate() {
    if (!params.id) return;
    setRegenerating(true);
    try {
      await generateArguments(params.id);
      await loadProject(params.id);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось перегенерировать аргументы');
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <main className="page">
      {!isTelegramAvailable && (
        <p>
          <Link href="/projects">← Мои разговоры</Link>
        </p>
      )}

      {loading && <p>Загрузка…</p>}
      {error && <p className="generation-error">{error}</p>}

      {project && (
        <>
          <h1>{project.question}</h1>
          {project.goal && <p className="project-detail__goal">Цель: {project.goal}</p>}
          <OpenLoopsSection projectId={project.id} />

          <DecisionObjectiveForm projectId={project.id} onSaved={handleRegenerate} />
          {regenerating && <p>Перегенерируем аргументы с учётом цели…</p>}
          <MissingInformationSection projectId={project.id} />
          <NegotiationBoundariesForm projectId={project.id} />

          <p>
            <Link href={`/projects/${project.id}/card`}>Открыть карточку разговора →</Link>
          </p>

          <ArgumentsList arguments={project.arguments} projectId={project.id} />
          <EvidenceGapSection projectId={project.id} />
          <ProtectedNotesSection projectId={project.id} />
          <ShareButton question={project.question} arguments={project.arguments} projectId={project.id} />

          <PeopleSection projectId={project.id} />
          <ConversationsSection projectId={project.id} />
          <ChatImportSection projectId={project.id} />
          <ProtocolSection projectId={project.id} />
          <SituationalContentSection projectId={project.id} />
          <CommitmentsSection projectId={project.id} />
          <PredictionsSection projectId={project.id} />
          <ArchetypePerspectivesSection projectId={project.id} />
          <StakeholderMapSection projectId={project.id} />
          <OutcomeScenariosSection projectId={project.id} />
          <ReconciliationArgumentsSection projectId={project.id} />
          <SchedulerSection projectId={project.id} />
          <AgendaSection projectId={project.id} />
          <DecisionOutcomeSection projectId={project.id} />
          <ClosingMessageSection projectId={project.id} />
          <ProjectLogSection projectId={project.id} />
          <SparringSection projectId={project.id} />
          <WorkingMaterialsSection projectId={project.id} />
          <PublicDiscussionSection projectId={project.id} publicShareToken={project.publicShareToken} />
          <LibrarySubmitSection projectId={project.id} hasLibraryEntry={project.libraryEntry !== null} />
        </>
      )}
    </main>
  );
}
