import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { SecretsModule } from './secrets/secrets.module';
import { ConsentModule } from './consent/consent.module';
import { ContentScanModule } from './content-scan/content-scan.module';
import { AIRouterModule } from './ai-router/ai-router.module';
import { TelegramAuthModule } from './telegram-auth/telegram-auth.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { LaunchDisclaimerModule } from './launch-disclaimer/launch-disclaimer.module';
import { ProjectsModule } from './projects/projects.module';
import { PersonsModule } from './persons/persons.module';
import { DecisionObjectiveModule } from './decision-objective/decision-objective.module';
import { NegotiationBoundariesModule } from './negotiation-boundaries/negotiation-boundaries.module';
import { ArgumentsModule } from './arguments/arguments.module';
import { SteelmanModule } from './steelman/steelman.module';
import { ConversationScriptModule } from './conversation-script/conversation-script.module';
import { ConversationCardModule } from './conversation-card/conversation-card.module';
import { PrivacyCenterModule } from './privacy-center/privacy-center.module';
import { SafeShareModule } from './safe-share/safe-share.module';
import { RetentionClassModule } from './retention-classes/retention-classes.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { AIEnginesModule } from './ai-engines/ai-engines.module';
import { ConversationsModule } from './conversations/conversations.module';
import { CommitmentsModule } from './commitments/commitments.module';
import { TurningPointsModule } from './turning-points/turning-points.module';
import { MissingInformationModule } from './missing-information/missing-information.module';
import { EvidenceGapModule } from './evidence-gap/evidence-gap.module';
import { DoNotSayModule } from './do-not-say/do-not-say.module';
import { BestNextMoveModule } from './best-next-move/best-next-move.module';
import { SourceConflictModule } from './source-conflict/source-conflict.module';
import { StaleFactModule } from './stale-fact/stale-fact.module';
import { OpenLoopsModule } from './open-loops/open-loops.module';
import { PredictionModule } from './prediction/prediction.module';
import { ConversationAgendaModule } from './conversation-agenda/conversation-agenda.module';
import { ProtectedNoteModule } from './protected-note/protected-note.module';
import { ManipulationDetectorModule } from './manipulation-detector/manipulation-detector.module';
import { DiscrepancyAnalysisModule } from './discrepancy-analysis/discrepancy-analysis.module';
import { ArchetypePerspectiveModule } from './archetype-perspective/archetype-perspective.module';
import { CommunicationProfileModule } from './communication-profile/communication-profile.module';
import { RelationshipsModule } from './relationships/relationships.module';
import { StakeholderMapModule } from './stakeholder-map/stakeholder-map.module';
import { PrecedentSearchModule } from './precedent-search/precedent-search.module';
import { OutcomeForecastingModule } from './outcome-forecasting/outcome-forecasting.module';
import { PhotoVerificationModule } from './photo-verification/photo-verification.module';
import { ReconciliationArgumentsModule } from './reconciliation-arguments/reconciliation-arguments.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { DecisionOutcomeModule } from './decision-outcome/decision-outcome.module';
import { SparringModule } from './sparring/sparring.module';
import { PublicDiscussionModule } from './public-discussion/public-discussion.module';
import { LibraryModule } from './library/library.module';
import { PersonFactsModule } from './person-facts/person-facts.module';
import { MotiveAnalysisModule } from './motive-analysis/motive-analysis.module';
import { WorkingMaterialsModule } from './working-materials/working-materials.module';
import { ChatImportModule } from './chat-import/chat-import.module';
import { ProtocolModule } from './protocol/protocol.module';
import { TextToSpeechModule } from './text-to-speech/text-to-speech.module';
import { SituationalContentModule } from './situational-content/situational-content.module';
import { VenueRecommendationModule } from './venue-recommendation/venue-recommendation.module';
import { VenueApplicationModule } from './venue-application/venue-application.module';
import { ReligiousReminderModule } from './religious-reminder/religious-reminder.module';
import { CompromiseSheetModule } from './compromise-sheet/compromise-sheet.module';
import { ClosingMessageModule } from './closing-message/closing-message.module';
import { ProjectLogModule } from './project-log/project-log.module';
import { WeatherForecastModule } from './weather-forecast/weather-forecast.module';
import { SchedulerAdviceModule } from './scheduler-advice/scheduler-advice.module';
import { LiveSessionModule } from './live-session/live-session.module';
import { LiveHintsModule } from './live-hints/live-hints.module';
import { LiveManipulationModule } from './live-manipulation/live-manipulation.module';
import { BreakingQuestionsModule } from './breaking-questions/breaking-questions.module';
import { LiveArgumentTrackingModule } from './live-argument-tracking/live-argument-tracking.module';
import { ProbingDetectorModule } from './probing-detector/probing-detector.module';
import { VoiceEmbeddingModule } from './voice-embedding/voice-embedding.module';
import { MaterialChatModule } from './material-chat/material-chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    SecretsModule,
    ConsentModule,
    ContentScanModule,
    AIRouterModule,
    TelegramAuthModule,
    BootstrapModule,
    LaunchDisclaimerModule,
    ProjectsModule,
    PersonsModule,
    DecisionObjectiveModule,
    NegotiationBoundariesModule,
    ArgumentsModule,
    SteelmanModule,
    ConversationScriptModule,
    ConversationCardModule,
    PrivacyCenterModule,
    SafeShareModule,
    RetentionClassModule,
    OnboardingModule,
    AIEnginesModule,
    ConversationsModule,
    CommitmentsModule,
    TurningPointsModule,
    MissingInformationModule,
    EvidenceGapModule,
    DoNotSayModule,
    BestNextMoveModule,
    SourceConflictModule,
    StaleFactModule,
    OpenLoopsModule,
    PredictionModule,
    ConversationAgendaModule,
    ProtectedNoteModule,
    ManipulationDetectorModule,
    DiscrepancyAnalysisModule,
    ArchetypePerspectiveModule,
    CommunicationProfileModule,
    RelationshipsModule,
    StakeholderMapModule,
    PrecedentSearchModule,
    OutcomeForecastingModule,
    PhotoVerificationModule,
    ReconciliationArgumentsModule,
    SchedulerModule,
    DecisionOutcomeModule,
    SparringModule,
    PublicDiscussionModule,
    LibraryModule,
    PersonFactsModule,
    MotiveAnalysisModule,
    WorkingMaterialsModule,
    ChatImportModule,
    ProtocolModule,
    TextToSpeechModule,
    SituationalContentModule,
    VenueRecommendationModule,
    VenueApplicationModule,
    ReligiousReminderModule,
    CompromiseSheetModule,
    ClosingMessageModule,
    ProjectLogModule,
    WeatherForecastModule,
    SchedulerAdviceModule,
    LiveSessionModule,
    LiveHintsModule,
    LiveManipulationModule,
    BreakingQuestionsModule,
    LiveArgumentTrackingModule,
    ProbingDetectorModule,
    VoiceEmbeddingModule,
    MaterialChatModule,
  ],
})
export class AppModule {}
