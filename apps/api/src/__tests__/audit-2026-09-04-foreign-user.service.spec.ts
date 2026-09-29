// Сверка мест применения барьеров 2026-09-04 — «проверка есть, но её
// удаление никто не заметит».
//
// Продолжение мутационной сверки ([mutation-audit]), которая нашла у меня
// систематический перекос: тест держит чистую функцию или запрос, а не
// место, где правило применяется. Здесь тот же приём применён ко всему
// классу проверок доступа: каждый из 179 однострочных вызовов барьера
// (`assertProjectOwnership` и доменные `assert*Access`) по очереди
// удалялся, и запускались все спеки, которые этот файл покрывают.
//
// 105 из 179 удалений набор НЕ ЗАМЕТИЛ: одна снятая строка отдаёт чужие
// данные, и зелёный прогон это подтверждает. Здесь закрыты все 105.
//
// Промежуточная ошибка, которую стоит помнить: сначала я разделил их
// скриптом на «есть вторая защита» (22) и «нет» (83), и хотел закрыть
// только вторую группу. Перепроверка мутацией показала, что деление
// ничего не значило — все 19 оставшихся мест из первой группы (три
// остальных были про согласие и заморозку и закрыты в своих спеках)
// после снятия барьера так же отдают чужой проект. Скрипт искал в теле
// метода запросы с `userId`, а находил параметры вызова модели и
// делегатов, которые проверяют своё. Выводы эвристики выброшены,
// оставлены выводы мутаций.
//
// Важно, чего это НЕ значит: [authz-sweep] проверял руками, что проверки
// СТОЯТ, и они стоят. Речь о другом — что их отсутствие не будет поймано.
// Разница ровно та же, что между «замок висит» и «кто-нибудь заметит,
// если его снимут».
//
// Как устроен этот тест и почему он не пустой. Фейк здесь НАМЕРЕННО
// разрешающий: любой поиск любой модели возвращает правдоподобную строку,
// поэтому упасть методу больше не на чем — единственный, кто может
// отказать, это барьер владения. Отказ проверяется не по типу (NotFound
// бросают и обычные «не найдено»), а по точному тексту `Project p-1 not
// found`, который есть только у барьеров. Плюс контрольная проверка внизу
// файла: тот же вызов от ВЛАДЕЛЬЦА этим текстом не падает — иначе тест
// проходил бы на методе, который всегда бросает.

import { NotFoundException } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';

import { BreakingQuestionsService } from '../breaking-questions/breaking-questions.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { ClosingMessageService } from '../closing-message/closing-message.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ConversationAgendaService } from '../conversation-agenda/conversation-agenda.service';
import { ConversationScriptService } from '../conversation-script/conversation-script.service';
import { DecisionObjectiveService } from '../decision-objective/decision-objective.service';
import { DoNotSayService } from '../do-not-say/do-not-say.service';
import { DtpService } from '../dtp/dtp.service';
import { DtpV2Service } from '../dtp/dtp-v2.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { EmployerHiringService } from '../employer-hiring/employer-hiring.service';
import { EngagementService } from '../employer-hiring/engagement.service';
import { EvidenceGapService } from '../evidence-gap/evidence-gap.service';
import { FamilyLawService } from '../family-law/family-law.service';
import { FamilyLawV2Service } from '../family-law/family-law-v2.service';
import { CvVariantService } from '../terms-sheet/cv-variant.service';
import { HealthService } from '../health/health.service';
import { InterviewPoolOnboardingService } from '../interview-pool/interview-pool-onboarding.service';
import { InterviewPoolRelevanceService } from '../interview-pool/interview-pool-relevance.service';
import { InterviewPoolReportService } from '../interview-pool/interview-pool-report.service';
import { InterviewPoolService } from '../interview-pool/interview-pool.service';
import { InvestmentOnboardingService } from '../investment/investment-onboarding.service';
import { InvestmentService } from '../investment/investment.service';
import { JobSearchOnboardingService } from '../job-search/job-search-onboarding.service';
import { JobSearchService } from '../job-search/job-search.service';
import { LiveArgumentTrackingService } from '../live-argument-tracking/live-argument-tracking.service';
import { LiveHintsService } from '../live-hints/live-hints.service';
import { LiveManipulationService } from '../live-manipulation/live-manipulation.service';
import { LiveSessionService } from '../live-session/live-session.service';
import { MaterialChatService } from '../material-chat/material-chat.service';
import { NegotiationBoundariesService } from '../negotiation-boundaries/negotiation-boundaries.service';
import { OpenLoopsService } from '../open-loops/open-loops.service';
import { OutcomeForecastingService } from '../outcome-forecasting/outcome-forecasting.service';
import { PersonsService } from '../persons/persons.service';
import { PredictionService } from '../prediction/prediction.service';
import { ProbingDetectorService } from '../probing-detector/probing-detector.service';
import { ProjectLogService } from '../project-log/project-log.service';
import { ProtectedNoteService } from '../protected-note/protected-note.service';
import { PublicDiscussionService } from '../public-discussion/public-discussion.service';
import { SchedulerAdviceService } from '../scheduler-advice/scheduler-advice.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { SituationalContentService } from '../situational-content/situational-content.service';
import { SourceConflictService } from '../source-conflict/source-conflict.service';
import { SparringService } from '../sparring/sparring.service';
import { StaleFactService } from '../stale-fact/stale-fact.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { JobSearchToolsService } from '../vacancy-intake/job-search-tools.service';
import { VacancyIntakeService } from '../vacancy-intake/vacancy-intake.service';
import { WorkingMaterialsService } from '../working-materials/working-materials.service';

const OWNER = 'владелец';
const STRANGER = 'посторонний';
const PROJECT_ID = 'p-1';
const OWNERSHIP_REFUSAL = new RegExp(`Project ${PROJECT_ID} not found`);

/** Разрешающий фейк: любой поиск возвращает правдоподобную строку, чтобы
 * методу было не на чем упасть, кроме самого барьера. Единственное
 * исключение — `project`: он и есть предмет проверки. */
function permissivePrisma(mode: ProjectMode, ownerId: string = OWNER) {
  const projectRow = {
    id: PROJECT_ID,
    ownerId,
    mode,
    recruitingTeamId: null,
    frozenAt: null,
    frozenNote: null,
    question: 'вопрос',
    goal: null,
    currency: 'UAH',
  };
  const genericRow = (where: any = {}) => ({
    id: where?.id ?? 'row-1',
    projectId: PROJECT_ID,
    employerProjectId: PROJECT_ID,
    agencyProjectId: PROJECT_ID,
    ownerId,
    ownerUserId: ownerId,
    userId: ownerId,
    sharedByUserId: ownerId,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: projectRow,
    // Поля, по которым доменные сервисы ходят дальше по цепочке до барьера.
    config: { id: 'cfg-1', projectId: PROJECT_ID },
    consultation: { id: 'c-1', projectId: PROJECT_ID },
    pipelineStatus: { id: 's-1', projectId: PROJECT_ID },
    conversation: { id: 'conv-1', projectId: PROJECT_ID },
    sheet: { id: 'sh-1', projectId: PROJECT_ID },
    report: { id: 'rep-1', projectId: PROJECT_ID },
    dossier: { id: 'dos-1', projectId: PROJECT_ID },
    brief: { id: 'br-1', projectId: PROJECT_ID },
    engagement: { id: 'eng-1', employerProjectId: PROJECT_ID, agencyProjectId: PROJECT_ID },
    evidence: { id: 'ev-1', projectId: PROJECT_ID },
    participant: { id: 'part-1', projectId: PROJECT_ID },
    material: { id: 'mat-1', projectId: PROJECT_ID },
    // Вложенные include, через которые доменные хелперы добираются до
    // projectId: consultation.advisor.config, meeting.opportunity.config.
    advisor: { id: 'adv-1', config: { id: 'cfg-1', projectId: PROJECT_ID } },
    opportunity: { id: 'op-1', configId: 'cfg-1', config: { id: 'cfg-1', projectId: PROJECT_ID } },
  });

  const model = (name: string): any =>
    new Proxy(
      {},
      {
        get(_t, op: string) {
          if (name === 'project') {
            if (op === 'findFirst') {
              return async ({ where }: any) =>
                where?.ownerId && where.ownerId !== ownerId ? null : projectRow;
            }
            if (op === 'findUnique' || op === 'findUniqueOrThrow') return async () => projectRow;
            if (op === 'findMany') return async () => [projectRow];
          }
          // Посторонний не состоит ни в одной команде — иначе командный
          // барьер пропустил бы его законно и тест бы ничего не значил.
          if (name === 'recruitingTeamMember') return async () => (op === 'findMany' ? [] : null);
          if (op === 'findMany') return async () => [];
          if (op === 'count') return async () => 0;
          if (op === 'aggregate') return async () => ({ _sum: {}, _count: 0 });
          if (op === 'updateMany' || op === 'deleteMany') return async () => ({ count: 0 });
          return async (args: any = {}) => genericRow(args?.where);
        },
      },
    );

  const cache = new Map<string, any>();
  const proxy: any = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(proxy) : arg);
        if (name === 'then') return undefined; // не притворяемся Promise
        if (!cache.has(name)) cache.set(name, model(name));
        return cache.get(name);
      },
    },
  );
  return proxy;
}

/** Любая зависимость сервиса, кроме prisma: метод возвращает пустоту.
 * До неё дело дойти не должно — барьер стоит раньше. */
function anyDep(): any {
  return new Proxy(
    function () {} as any,
    {
      get: () => anyDep(),
      apply: () => Promise.resolve({}),
    },
  );
}

interface Case {
  name: string;
  mode?: ProjectMode;
  call: (prisma: any) => Promise<unknown>;
}

const D = () => anyDep();

const CASES: Case[] = [
  // ── обычное владение проектом ──
  { name: 'BreakingQuestionsService.list', call: (p) => new BreakingQuestionsService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'ClosingMessageService.list', call: (p) => new ClosingMessageService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'CommitmentsService.listByProject', call: (p) => new CommitmentsService(p).listByProject(STRANGER, PROJECT_ID) },
  { name: 'ConversationAgendaService.getLatest', call: (p) => new ConversationAgendaService(p, D()).getLatest(STRANGER, PROJECT_ID) },
  { name: 'ConversationScriptService.getLatest', call: (p) => new ConversationScriptService(p, D()).getLatest(STRANGER, PROJECT_ID) },
  { name: 'ConversationScriptService.list', call: (p) => new ConversationScriptService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'DecisionObjectiveService.get', call: (p) => new DecisionObjectiveService(p).get(STRANGER, PROJECT_ID) },
  { name: 'DoNotSayService.listForProject', call: (p) => new DoNotSayService(p, D()).listForProject(STRANGER, PROJECT_ID) },
  { name: 'EvidenceGapService.analyze', call: (p) => new EvidenceGapService(p).analyze(STRANGER, PROJECT_ID) },
  { name: 'LiveArgumentTrackingService.list', call: (p) => new LiveArgumentTrackingService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'LiveHintsService.list', call: (p) => new LiveHintsService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'LiveHintsService.markDismissed', call: (p) => new LiveHintsService(p, D()).markDismissed(STRANGER, PROJECT_ID, 'ev-1') },
  { name: 'LiveManipulationService.list', call: (p) => new LiveManipulationService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'LiveSessionService.list', call: (p) => new LiveSessionService(p, D(), D()).list(STRANGER, PROJECT_ID) },
  { name: 'LiveSessionService.markDismissed', call: (p) => new LiveSessionService(p, D(), D()).markDismissed(STRANGER, PROJECT_ID, 'ev-1') },
  { name: 'NegotiationBoundariesService.get', call: (p) => new NegotiationBoundariesService(p).get(STRANGER, PROJECT_ID) },
  { name: 'OutcomeForecastingService.confirmOutcome', call: (p) => new OutcomeForecastingService(p, D()).confirmOutcome(STRANGER, PROJECT_ID, 'sc-1', true) },
  { name: 'PersonsService.removePerson', call: (p) => new PersonsService(p).removePerson(STRANGER, PROJECT_ID, 'per-1') },
  { name: 'PersonsService.updateStatus', call: (p) => new PersonsService(p).updateStatus(STRANGER, PROJECT_ID, 'per-1', { status: 'FIGURANT' } as any) },
  { name: 'PredictionService.list', call: (p) => new PredictionService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'ProbingDetectorService.list', call: (p) => new ProbingDetectorService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'ProjectLogService.setFlagDisputed', call: (p) => new ProjectLogService(p).setFlagDisputed(STRANGER, PROJECT_ID, 'sig-1', true) },
  { name: 'ProtectedNoteService.list', call: (p) => new ProtectedNoteService(p).list(STRANGER, PROJECT_ID) },
  { name: 'PublicDiscussionService.disableSharing', call: (p) => new PublicDiscussionService(p, D()).disableSharing(STRANGER, PROJECT_ID) },
  { name: 'PublicDiscussionService.moderate', call: (p) => new PublicDiscussionService(p, D()).moderate(STRANGER, PROJECT_ID, 'sub-1', 'ACCEPT') },
  { name: 'SchedulerAdviceService.list', call: (p) => new SchedulerAdviceService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'SchedulerService.listForProject', call: (p) => new SchedulerService(p, D()).listForProject(STRANGER, PROJECT_ID) },
  { name: 'SituationalContentService.listAnecdotes', call: (p) => new SituationalContentService(p, D()).listAnecdotes(STRANGER, PROJECT_ID) },
  { name: 'SituationalContentService.listQuotes', call: (p) => new SituationalContentService(p, D()).listQuotes(STRANGER, PROJECT_ID) },
  { name: 'SourceConflictService.listUnresolvedForProject', call: (p) => new SourceConflictService(p, D()).listUnresolvedForProject(STRANGER, PROJECT_ID) },
  { name: 'SparringService.listSessions', call: (p) => new SparringService(p, D(), D(), D(), D(), D()).listSessions(STRANGER, PROJECT_ID) },
  { name: 'StaleFactService.listForProject', call: (p) => new StaleFactService(p).listForProject(STRANGER, PROJECT_ID) },
  { name: 'WorkingMaterialsService.getMaterial', call: (p) => new WorkingMaterialsService(p, D()).getMaterial(STRANGER, PROJECT_ID, 'mat-1') },
  { name: 'WorkingMaterialsService.listMaterials', call: (p) => new WorkingMaterialsService(p, D()).listMaterials(STRANGER, PROJECT_ID) },
  { name: 'MaterialChatService.findOwnedMaterial (через приватный хелпер)', call: (p) => (new MaterialChatService(p, D(), D(), D(), D(), D()) as any).findOwnedMaterial(STRANGER, PROJECT_ID, 'mat-1') },

  // ── домены-консультации: конфиг, консультация, советник ──
  { name: 'DtpService.createConfig', call: (p) => new DtpService(p, D(), D(), D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'DtpService.assertOwnedConfig', call: (p) => (new DtpService(p, D(), D(), D()) as any).assertOwnedConfig(STRANGER, 'cfg-1') },
  { name: 'DtpService.assertOwnedAdvisor', call: (p) => (new DtpService(p, D(), D(), D()) as any).assertOwnedAdvisor(STRANGER, 'adv-1') },
  { name: 'DtpService.assertOwnedConsultation', call: (p) => (new DtpService(p, D(), D(), D()) as any).assertOwnedConsultation(STRANGER, 'c-1') },
  { name: 'DtpV2Service.getEvidenceAccessLog', call: (p) => new DtpV2Service(p, D()).getEvidenceAccessLog(STRANGER, 'ev-1') },
  { name: 'DtpV2Service.assertOwnedConfig', call: (p) => (new DtpV2Service(p, D()) as any).assertOwnedConfig(STRANGER, 'cfg-1') },
  { name: 'DtpV2Service.assertOwnedParticipant', call: (p) => (new DtpV2Service(p, D()) as any).assertOwnedParticipant(STRANGER, 'part-1') },
  { name: 'FamilyLawService.createConfig', call: (p) => new FamilyLawService(p, D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'FamilyLawService.assertOwnedConfig', call: (p) => (new FamilyLawService(p, D()) as any).assertOwnedConfig(STRANGER, 'cfg-1') },
  { name: 'FamilyLawService.assertOwnedAdvisor', call: (p) => (new FamilyLawService(p, D()) as any).assertOwnedAdvisor(STRANGER, 'adv-1') },
  { name: 'FamilyLawService.assertOwnedConsultation', call: (p) => (new FamilyLawService(p, D()) as any).assertOwnedConsultation(STRANGER, 'c-1') },
  { name: 'HealthService.createConfig', call: (p) => new HealthService(p, D(), D(), D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'HealthService.assertOwnedProvider', call: (p) => (new HealthService(p, D(), D(), D()) as any).assertOwnedProvider(STRANGER, 'prov-1') },
  { name: 'InvestmentService.createConfig', call: (p) => new InvestmentService(p, D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'InvestmentService.assertOwnedConfig', call: (p) => (new InvestmentService(p, D()) as any).assertOwnedConfig(STRANGER, 'cfg-1') },
  { name: 'InvestmentService.assertOwnedMeeting', call: (p) => (new InvestmentService(p, D()) as any).assertOwnedMeeting(STRANGER, 'm-1') },
  { name: 'InvestmentService.assertOwnedOpportunity', call: (p) => (new InvestmentService(p, D()) as any).assertOwnedOpportunity(STRANGER, 'op-1') },
  { name: 'InvestmentOnboardingService.assertOwnedConversation', call: (p) => (new InvestmentOnboardingService(p, D()) as any).assertOwnedConversation(STRANGER, 'conv-1') },

  // ── поиск работы (режим проекта JOB_SEARCH) ──
  { name: 'JobSearchService.createConfig', mode: ProjectMode.JOB_SEARCH, call: (p) => new JobSearchService(p, D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'JobSearchService.getConfig', mode: ProjectMode.JOB_SEARCH, call: (p) => new JobSearchService(p, D()).getConfig(STRANGER, PROJECT_ID) },
  { name: 'JobSearchOnboardingService.createOnboardingConversation', mode: ProjectMode.JOB_SEARCH, call: (p) => new JobSearchOnboardingService(p, D()).createOnboardingConversation(STRANGER, PROJECT_ID) },
  { name: 'JobSearchToolsService.ctx (через приватный хелпер)', mode: ProjectMode.JOB_SEARCH, call: (p) => (new JobSearchToolsService(p, D(), D()) as any).ctx(STRANGER, PROJECT_ID) },
  { name: 'VacancyIntakeService.config (через приватный хелпер)', mode: ProjectMode.JOB_SEARCH, call: (p) => (new VacancyIntakeService(p) as any).config(STRANGER, PROJECT_ID) },

  // ── найм: пул интервью и работодатель (командный барьер) ──
  { name: 'InterviewPoolService.createConfig', call: (p) => new InterviewPoolService(p, D()).createConfig(STRANGER, PROJECT_ID, {} as any) },
  { name: 'InterviewPoolService.fixQuestionnaire', call: (p) => new InterviewPoolService(p, D()).fixQuestionnaire(STRANGER, PROJECT_ID, [] as any) },
  { name: 'InterviewPoolService.listCandidates', call: (p) => new InterviewPoolService(p, D()).listCandidates(STRANGER, PROJECT_ID) },
  // Единственный метод в этом списке, куда проект приходит не аргументом,
  // а через строку пайплайна: барьер стоит после её загрузки.
  { name: 'InterviewPoolService.recordStageProgress', call: (p) => new InterviewPoolService(p, D()).recordStageProgress(STRANGER, 's-1', 'stage-1') },
  { name: 'InterviewPoolRelevanceService.getHistory', call: (p) => new InterviewPoolRelevanceService(p, D()).getHistory(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolRelevanceService.getLatest', call: (p) => new InterviewPoolRelevanceService(p, D()).getLatest(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolReportService.generateSummaryReport', call: (p) => new InterviewPoolReportService(p, D()).generateSummaryReport(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolReportService.list', call: (p) => new InterviewPoolReportService(p, D()).list(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolReportService.assertOwnedReport', call: (p) => (new InterviewPoolReportService(p, D()) as any).assertOwnedReport(STRANGER, 'rep-1') },
  { name: 'InterviewPoolOnboardingService.assertOwnedConversation', call: (p) => (new InterviewPoolOnboardingService(p, D()) as any).assertOwnedConversation(STRANGER, 'conv-1') },
  { name: 'EngagementService.listForAgency', call: (p) => new EngagementService(p, D()).listForAgency(STRANGER, PROJECT_ID) },
  { name: 'EngagementService.deliverReport', call: (p) => new EngagementService(p, D()).deliverReport(STRANGER, 'rep-1', 'eng-1') },
  { name: 'EngagementService.getForEmployer (через приватный хелпер)', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => (new EngagementService(p, D()) as any).getForEmployer(STRANGER, 'eng-1') },
  { name: 'EngagementService.deliveredReports', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EngagementService(p, D()).deliveredReports(STRANGER, PROJECT_ID) },
  { name: 'EngagementService.listForEmployer', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EngagementService(p, D()).listForEmployer(STRANGER, PROJECT_ID) },
  { name: 'EmployerHiringService.createOnboardingConversation', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EmployerHiringService(p, D()).createOnboardingConversation(STRANGER, PROJECT_ID) },
  { name: 'EmployerHiringService.appendAnswer', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EmployerHiringService(p, D()).appendAnswer(STRANGER, 'conv-1', 'ответ') },
  { name: 'TermsSheetService.listForProject', call: (p) => new TermsSheetService(p, D(), D()).listForProject(STRANGER, PROJECT_ID) },
  { name: 'ClientBriefService.list', call: (p) => new ClientBriefService(p, D(), D(), D()).list(STRANGER, PROJECT_ID) },
  { name: 'ClientBriefService.getOwned', call: (p) => (new ClientBriefService(p, D(), D(), D()) as any).getOwned(STRANGER, 'br-1') },
  { name: 'EmployerDossierService.list', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EmployerDossierService(p, D(), D()).list(STRANGER, PROJECT_ID) },
  { name: 'EmployerDossierService.check', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EmployerDossierService(p, D(), D()).check(STRANGER, 'claim-1') },
  { name: 'EmployerDossierService.getOwned', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => (new EmployerDossierService(p, D(), D()) as any).getOwned(STRANGER, 'dos-1') },

  // ── методы, где мой скрипт сначала решил, что «вторая защита есть» ──
  //
  // Черновая эвристика искала в теле метода запросы, ограниченные по
  // userId, и на этом основании считала снятие барьера безобидным. При
  // перепроверке мутацией все 19 таких мест оказались обычными: после
  // снятия барьера запросы идут по одному projectId, а найденный
  // «userId» был либо параметром вызова модели, либо делегатом, который
  // проверяет своё, а не это. Эвристика ошиблась в безопасную сторону
  // ровно один раз из 19 — то есть не ошиблась, а просто не работала;
  // выводы из неё выброшены, оставлены выводы из мутаций.
  { name: 'BreakingQuestionsService.generate', call: (p) => new BreakingQuestionsService(p, D()).generate(STRANGER, PROJECT_ID, 'окно') },
  { name: 'CommitmentsService.create', call: (p) => new CommitmentsService(p).create(STRANGER, PROJECT_ID, {} as any) },
  { name: 'OpenLoopsService.getSummary', call: (p) => new OpenLoopsService(p, D()).getSummary(STRANGER, PROJECT_ID) },
  { name: 'LiveHintsService.analyze', call: (p) => new LiveHintsService(p, D()).analyze(STRANGER, PROJECT_ID, 'окно') },
  { name: 'LiveHintsService.analyzeForInterview', call: (p) => new LiveHintsService(p, D()).analyzeForInterview(STRANGER, PROJECT_ID, 'окно') },
  { name: 'LiveManipulationService.analyze', call: (p) => new LiveManipulationService(p, D()).analyze(STRANGER, PROJECT_ID, 'окно') },
  // initialize() в конце зовёт list(), у которого барьер свой, поэтому
  // отказ здесь придёт и без собственной проверки. Что теряется без неё —
  // отдельным тестом ниже: строки трекинга успевают создаться.
  { name: 'LiveArgumentTrackingService.initialize', call: (p) => new LiveArgumentTrackingService(p, D()).initialize(STRANGER, PROJECT_ID) },
  { name: 'LiveArgumentTrackingService.checkStatus', call: (p) => new LiveArgumentTrackingService(p, D()).checkStatus(STRANGER, PROJECT_ID, 'окно') },
  { name: 'ProbingDetectorService.analyze', call: (p) => new ProbingDetectorService(p, D()).analyze(STRANGER, PROJECT_ID, 'окно') },
  { name: 'DtpV2Service.crossConsultationCheck', call: (p) => new DtpV2Service(p, D()).crossConsultationCheck(STRANGER, 'crit-1') },
  { name: 'FamilyLawV2Service.crossConsultationCheck', call: (p) => new FamilyLawV2Service(p, D()).crossConsultationCheck(STRANGER, 'crit-1') },
  { name: 'InterviewPoolService.generateQuestionnaireDraft', call: (p) => new InterviewPoolService(p, D()).generateQuestionnaireDraft(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolService.addCandidate', call: (p) => new InterviewPoolService(p, D()).addCandidate(STRANGER, PROJECT_ID, 'cand-1', false) },
  { name: 'InterviewPoolService.getAgenda', call: (p) => new InterviewPoolService(p, D()).getAgenda(STRANGER, PROJECT_ID, 'cand-1') },
  { name: 'InterviewPoolRelevanceService.regenerate', call: (p) => new InterviewPoolRelevanceService(p, D()).regenerate(STRANGER, PROJECT_ID) },
  { name: 'InterviewPoolReportService.generateCandidateReport', call: (p) => new InterviewPoolReportService(p, D()).generateCandidateReport(STRANGER, PROJECT_ID, 'cand-1') },
  { name: 'EmployerHiringService.extract', mode: ProjectMode.EMPLOYER_HIRING, call: (p) => new EmployerHiringService(p, D()).extract(STRANGER, 'conv-1') },
  { name: 'TermsSheetService.openForCandidate', call: (p) => new TermsSheetService(p, D(), D()).openForCandidate(STRANGER, 's-1') },
  { name: 'CvVariantService.consistency', call: (p) => new CvVariantService(p, D(), D()).consistency(STRANGER, PROJECT_ID) },
];

describe('Барьеры доступа: посторонний получает отказ на каждом месте применения', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    'КЛЮЧЕВОЙ ТЕСТ: %s — чужой userId отклонён самим барьером',
    async (_name, testCase) => {
      const prisma = permissivePrisma(testCase.mode ?? ProjectMode.INTERVIEW_POOL);
      const err = await testCase.call(prisma).then(
        (value) => ({ ok: true, value }) as any,
        (e: any) => ({ ok: false, e }),
      );
      expect(err.ok).toBe(false);
      // Именно барьер, а не случайное «не найдено»: текст отказа
      // называет проект. Всё остальное фейк отдаёт успешно.
      expect(err.e).toBeInstanceOf(NotFoundException);
      expect(String(err.e.message)).toMatch(OWNERSHIP_REFUSAL);
    },
  );

  it('КЛЮЧЕВОЙ ТЕСТ: initialize() постороннего не оставляет строк в чужом проекте — отказ в конце метода не отменяет записи в начале', async () => {
    // Единственное из 179 мест, где отказ приходит и без собственного
    // барьера: `initialize()` заканчивается вызовом `list()`, а у того
    // проверка своя. Но между ними метод СОЗДАЁТ строки трекинга — то
    // есть посторонний получил бы отказ и всё равно оставил бы следы в
    // чужом проекте. Общий табличный тест такого не видит (он смотрит на
    // отказ), поэтому здесь проверяется именно отсутствие записей.
    const created: any[] = [];
    const prisma: any = {
      project: {
        findFirst: async ({ where }: any) =>
          where?.ownerId && where.ownerId !== OWNER ? null : { id: PROJECT_ID, ownerId: OWNER, question: 'вопрос', goal: null },
      },
      argument: { findMany: async () => [{ id: 'arg-1', projectId: PROJECT_ID }] },
      liveArgumentTrackingStatus: {
        findUnique: async () => null,
        findMany: async () => [],
        create: async ({ data }: any) => {
          created.push(data);
          return data;
        },
      },
    };

    await expect(new LiveArgumentTrackingService(prisma, D()).initialize(STRANGER, PROJECT_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(created).toEqual([]);
  });

  it('КОНТРОЛЬ (защита от пустого теста): если тот же вызывающий — ВЛАДЕЛЕЦ проекта, этого отказа нет ни у одного случая', async () => {
    // Тот же вызов и тот же разрешающий фейк, разница ровно одна:
    // владельцем проекта записан сам вызывающий. Если «Project p-1 not
    // found» приходит и здесь, значит в основном тесте отказ давала не
    // проверка владения, и тест выше ничего не значит. Метод при этом
    // может упасть на чём-то другом — фейк не заменяет настоящую БД, и
    // это нормально: проверяется не успех, а отсутствие ИМЕННО этого
    // отказа.
    const wrongly: string[] = [];
    for (const testCase of CASES) {
      const prisma = permissivePrisma(testCase.mode ?? ProjectMode.INTERVIEW_POOL, STRANGER);
      const res = await testCase.call(prisma).then(
        () => null,
        (e: any) => e,
      );
      if (res instanceof NotFoundException && OWNERSHIP_REFUSAL.test(String(res.message))) {
        wrongly.push(testCase.name);
      }
    }
    expect(wrongly).toEqual([]);
  });
});
