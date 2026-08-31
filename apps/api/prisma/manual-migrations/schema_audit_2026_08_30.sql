-- Аудит моделей БД 2026-08-30 — эквивалент миграции для schema.prisma.
-- Как и остальное в manual-migrations: для сверки с `prisma migrate dev` или ручного
-- применения. Всё аддитивно: индексы на FK-колонки (Postgres их НЕ создаёт сам,
-- Prisma при relationMode=foreignKeys — тоже), updatedAt на моделях, которые код
-- реально обновляет, createdAt там, где не было ни одной временной метки.
-- CONCURRENTLY нельзя внутри транзакции — при ручном применении через psql
-- выполняйте файл без BEGIN/COMMIT (или уберите CONCURRENTLY).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "projects_ownerId_idx" ON "projects"("ownerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "projects_recruitingTeamId_idx" ON "projects"("recruitingTeamId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "projects_investmentGroupId_idx" ON "projects"("investmentGroupId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "arguments_targetPersonId_idx" ON "arguments"("targetPersonId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "arguments_derivedFromPersonFactId_idx" ON "arguments"("derivedFromPersonFactId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "arguments_derivedFromInferenceId_idx" ON "arguments"("derivedFromInferenceId");
ALTER TABLE "project_people" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_inferences_modelVersionId_idx" ON "ai_inferences"("modelVersionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_inferences_promptVersionId_idx" ON "ai_inferences"("promptVersionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_inference_sources_personFactId_idx" ON "ai_inference_sources"("personFactId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_inference_sources_observationId_idx" ON "ai_inference_sources"("observationId");
ALTER TABLE "conversation_signals" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_signal_evidence_personFactId_idx" ON "conversation_signal_evidence"("personFactId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_signal_evidence_observationId_idx" ON "conversation_signal_evidence"("observationId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_signal_evidence_aiInferenceId_idx" ON "conversation_signal_evidence"("aiInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_transcriptionProviderVersionId_idx" ON "conversations"("transcriptionProviderVersionId");
ALTER TABLE "conversation_participants" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_agendas_generatedByInferenceId_idx" ON "conversation_agendas"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_jobs_promptVersionId_idx" ON "ai_jobs"("promptVersionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evaluation_runs_promptVersionId_idx" ON "evaluation_runs"("promptVersionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evaluation_runs_modelVersionId_idx" ON "evaluation_runs"("modelVersionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evaluation_runs_evaluationDatasetId_idx" ON "evaluation_runs"("evaluationDatasetId");
ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evaluation_case_results_evaluationCaseId_idx" ON "evaluation_case_results"("evaluationCaseId");
ALTER TABLE "evaluation_metrics" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evaluation_results_evaluationMetricId_idx" ON "evaluation_results"("evaluationMetricId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "consent_records_projectId_idx" ON "consent_records"("projectId");
ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "project_log_entry_people_personId_idx" ON "project_log_entry_people"("personId");
ALTER TABLE "project_log_entry_people" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "content_scan_results" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "steelman_cases_personId_idx" ON "steelman_cases"("personId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "steelman_cases_derivedFromInferenceId_idx" ON "steelman_cases"("derivedFromInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "steelman_supporting_facts_personFactId_idx" ON "steelman_supporting_facts"("personFactId");
ALTER TABLE "steelman_supporting_facts" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_scripts_personId_idx" ON "conversation_scripts"("personId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_scripts_derivedFromInferenceId_idx" ON "conversation_scripts"("derivedFromInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "safe_share_actions_projectId_idx" ON "safe_share_actions"("projectId");
ALTER TABLE "safe_share_actions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "commitments_extractedFromConversationId_idx" ON "commitments"("extractedFromConversationId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "commitments_extractedFromSegmentId_idx" ON "commitments"("extractedFromSegmentId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "missing_information_checks_generatedByInferenceId_idx" ON "missing_information_checks"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "best_next_move_recommendations_generatedByInferenceId_idx" ON "best_next_move_recommendations"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "source_conflicts_generatedByInferenceId_idx" ON "source_conflicts"("generatedByInferenceId");
ALTER TABLE "source_conflicts" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "argument_lifecycle_events_conversationId_idx" ON "argument_lifecycle_events"("conversationId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "predictions_generatedByInferenceId_idx" ON "predictions"("generatedByInferenceId");
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "archetype_perspectives_targetPersonId_idx" ON "archetype_perspectives"("targetPersonId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "archetype_perspectives_generatedByInferenceId_idx" ON "archetype_perspectives"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "person_communication_traits_generatedByInferenceId_idx" ON "person_communication_traits"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "behavior_precedents_generatedByInferenceId_idx" ON "behavior_precedents"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outcome_scenarios_generatedByInferenceId_idx" ON "outcome_scenarios"("generatedByInferenceId");
ALTER TABLE "outcome_scenarios" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_conversations_personId_idx" ON "scheduled_conversations"("personId");
ALTER TABLE "scheduled_conversations" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "decision_outcomes" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sparring_sessions_targetPersonId_idx" ON "sparring_sessions"("targetPersonId");
ALTER TABLE "sparring_sessions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sparring_messages_generatedByInferenceId_idx" ON "sparring_messages"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "public_argument_submissions_participantId_idx" ON "public_argument_submissions"("participantId");
ALTER TABLE "public_argument_submissions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "public_comments_participantId_idx" ON "public_comments"("participantId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "library_entries_submittedByUserId_idx" ON "library_entries"("submittedByUserId");
ALTER TABLE "library_entries" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "library_arguments" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "motive_hypotheses_projectId_idx" ON "motive_hypotheses"("projectId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "motive_hypotheses_generatedByInferenceId_idx" ON "motive_hypotheses"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "material_versions_generatedByInferenceId_idx" ON "material_versions"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "protocols_generatedByInferenceId_idx" ON "protocols"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "situational_quotes_generatedByInferenceId_idx" ON "situational_quotes"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "situational_anecdotes_generatedByInferenceId_idx" ON "situational_anecdotes"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "venue_recommendations_generatedByInferenceId_idx" ON "venue_recommendations"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "venue_applications_submittedByUserId_idx" ON "venue_applications"("submittedByUserId");
ALTER TABLE "venue_applications" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "approved_venues" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "venue_booking_confirmations_confirmedByUserId_idx" ON "venue_booking_confirmations"("confirmedByUserId");
ALTER TABLE "sparring_voice_reply_jobs" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "compromise_sheets_generatedByInferenceId_idx" ON "compromise_sheets"("generatedByInferenceId");
ALTER TABLE "compromise_sheets" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "compromise_sheet_items_argumentId_idx" ON "compromise_sheet_items"("argumentId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "closing_messages_generatedByInferenceId_idx" ON "closing_messages"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "weather_forecasts_generatedByInferenceId_idx" ON "weather_forecasts"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduler_advice_generatedByInferenceId_idx" ON "scheduler_advice"("generatedByInferenceId");
ALTER TABLE "cooldown_nudge_events" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "live_hint_events_suggestedArgumentId_idx" ON "live_hint_events"("suggestedArgumentId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "live_hint_events_suggestedQuestionnaireItemId_idx" ON "live_hint_events"("suggestedQuestionnaireItemId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "live_hint_events_generatedByInferenceId_idx" ON "live_hint_events"("generatedByInferenceId");
ALTER TABLE "live_hint_events" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "live_manipulation_flags_generatedByInferenceId_idx" ON "live_manipulation_flags"("generatedByInferenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "breaking_question_sets_generatedByInferenceId_idx" ON "breaking_question_sets"("generatedByInferenceId");
ALTER TABLE "live_argument_tracking_statuses" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "probing_topics" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "material_chat_sessions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "material_chat_messages_generatedByInferenceId_idx" ON "material_chat_messages"("generatedByInferenceId");
ALTER TABLE "material_chat_voice_reply_jobs" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "media_review_queue_items_conversationId_idx" ON "media_review_queue_items"("conversationId");
ALTER TABLE "media_review_queue_items" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "fact_check_api_cache" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "purchase_variants_configId_idx" ON "purchase_variants"("configId");
ALTER TABLE "purchase_variants" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "purchase_meetings_variantId_idx" ON "purchase_meetings"("variantId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "purchase_meetings_conversationId_idx" ON "purchase_meetings"("conversationId");
ALTER TABLE "purchase_meetings" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "market_comparisons_variantId_idx" ON "market_comparisons"("variantId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recruiting_team_members_userId_idx" ON "recruiting_team_members"("userId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recruiting_team_invites_teamId_idx" ON "recruiting_team_invites"("teamId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_profiles_ownerUserId_idx" ON "candidate_profiles"("ownerUserId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_profiles_recruitingTeamId_idx" ON "candidate_profiles"("recruitingTeamId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_stage_progress_stageDefinitionId_idx" ON "candidate_stage_progress"("stageDefinitionId");
ALTER TABLE "candidate_stage_progress" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "compliance_flags_configId_idx" ON "compliance_flags"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_pipeline_statuses_candidateProfileId_idx" ON "candidate_pipeline_statuses"("candidateProfileId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_follow_up_requests_statusId_idx" ON "candidate_follow_up_requests"("statusId");
ALTER TABLE "candidate_follow_up_requests" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "pool_relevance_entries_snapshotId_idx" ON "pool_relevance_entries"("snapshotId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "pool_relevance_entries_candidateProfileId_idx" ON "pool_relevance_entries"("candidateProfileId");
ALTER TABLE "pool_relevance_entries" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_shares_sourceCandidateId_idx" ON "candidate_shares"("sourceCandidateId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_shares_sharedByUserId_idx" ON "candidate_shares"("sharedByUserId");
ALTER TABLE "candidate_shares" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "client_reports_projectId_idx" ON "client_reports"("projectId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "client_reports_candidateProfileId_idx" ON "client_reports"("candidateProfileId");
ALTER TABLE "client_reports" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_opportunities_configId_idx" ON "investment_opportunities"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_meetings_opportunityId_idx" ON "investment_meetings"("opportunityId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_meetings_conversationId_idx" ON "investment_meetings"("conversationId");
ALTER TABLE "investment_meetings" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_source_comparisons_opportunityId_idx" ON "investment_source_comparisons"("opportunityId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_group_members_userId_idx" ON "investment_group_members"("userId");
ALTER TABLE "investment_group_members" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "investment_group_invites_groupId_idx" ON "investment_group_invites"("groupId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_providers_configId_idx" ON "health_providers"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_source_references_providerId_idx" ON "health_source_references"("providerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_consultations_providerId_idx" ON "health_consultations"("providerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_consultations_conversationId_idx" ON "health_consultations"("conversationId");
ALTER TABLE "health_consultations" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_lab_document_drafts_configId_idx" ON "health_lab_document_drafts"("configId");
ALTER TABLE "health_lab_document_drafts" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_advisors_configId_idx" ON "family_law_advisors"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_consultations_advisorId_idx" ON "family_law_consultations"("advisorId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_consultations_conversationId_idx" ON "family_law_consultations"("conversationId");
ALTER TABLE "family_law_consultations" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_advisors_configId_idx" ON "dtp_advisors"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_consultations_advisorId_idx" ON "dtp_consultations"("advisorId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_consultations_conversationId_idx" ON "dtp_consultations"("conversationId");
ALTER TABLE "dtp_consultations" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_evidence_items_configId_idx" ON "dtp_evidence_items"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_participants_configId_idx" ON "dtp_participants"("configId");
ALTER TABLE "dtp_participant_insurance" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_fault_determinations_configId_idx" ON "dtp_fault_determinations"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_budget_line_items_configId_idx" ON "dtp_budget_line_items"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_budget_line_items_participantId_idx" ON "dtp_budget_line_items"("participantId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_budget_line_items_consultationId_idx" ON "dtp_budget_line_items"("consultationId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dtp_evidence_access_logs_evidenceId_idx" ON "dtp_evidence_access_logs"("evidenceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_parties_configId_idx" ON "family_law_parties"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_assets_configId_idx" ON "family_law_assets"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_assets_ownerId_idx" ON "family_law_assets"("ownerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_status_determinations_configId_idx" ON "family_law_status_determinations"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_budget_line_items_configId_idx" ON "family_law_budget_line_items"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_budget_line_items_partyId_idx" ON "family_law_budget_line_items"("partyId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_budget_line_items_consultationId_idx" ON "family_law_budget_line_items"("consultationId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "family_law_goal_revisions_configId_idx" ON "family_law_goal_revisions"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_budget_line_items_configId_idx" ON "health_budget_line_items"("configId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "health_budget_line_items_consultationId_idx" ON "health_budget_line_items"("consultationId");

-- ── Удаление 5 неиспользуемых моделей (решение владельца, 2026-08-30) ──
-- Ни одного обращения из кода (проверено по prisma.<model>. и nested
-- create/include). Данные в этих таблицах — только если писались ранней
-- архитектурой фактов; перед DROP при желании сделать pg_dump этих таблиц.
-- SteelmanSupportingFact оставлена: используется через nested create в
-- steelman.service.ts (первичная проверка по prisma.<model>. её пропустила).
ALTER TABLE "conversation_signal_evidence" DROP COLUMN IF EXISTS "observationId";
DROP TABLE IF EXISTS "project_log_entry_people";
DROP TABLE IF EXISTS "project_log_entries";
DROP TABLE IF EXISTS "ai_inference_sources";
DROP TABLE IF EXISTS "fact_assertions";
DROP TABLE IF EXISTS "observations";
DROP TYPE IF EXISTS "ObservationSourceType";
DROP TYPE IF EXISTS "ProjectLogEventType";
DROP TYPE IF EXISTS "LogColorTone";

-- ── §2.1 Деньги: Float → Decimal(14,2) (решение владельца, 2026-08-30) ──
-- double precision → numeric без потери: существующие значения округляются
-- до копеек (они и были копейками, введёнными пользователем).
ALTER TABLE "approved_venues"              ALTER COLUMN "referralFeeAmount" TYPE NUMERIC(14,2);
ALTER TABLE "venue_booking_confirmations"  ALTER COLUMN "referralFeeOwed"   TYPE NUMERIC(14,2);
ALTER TABLE "major_purchase_configs"       ALTER COLUMN "budgetMin"         TYPE NUMERIC(14,2), ALTER COLUMN "budgetMax" TYPE NUMERIC(14,2);
ALTER TABLE "purchase_variants"            ALTER COLUMN "askingPrice"       TYPE NUMERIC(14,2);
ALTER TABLE "market_comparisons"           ALTER COLUMN "extractedPrice"    TYPE NUMERIC(14,2);
ALTER TABLE "investment_configs"           ALTER COLUMN "targetBudget"      TYPE NUMERIC(14,2);
ALTER TABLE "investment_group_members"     ALTER COLUMN "pledgedAmount"     TYPE NUMERIC(14,2);
ALTER TABLE "health_configs"               ALTER COLUMN "targetBudget"      TYPE NUMERIC(14,2);
ALTER TABLE "health_consultations"         ALTER COLUMN "estimatedCost"     TYPE NUMERIC(14,2);
ALTER TABLE "family_law_configs"           ALTER COLUMN "targetBudget"      TYPE NUMERIC(14,2);
ALTER TABLE "family_law_consultations"     ALTER COLUMN "estimatedCost"     TYPE NUMERIC(14,2);
ALTER TABLE "dtp_configs"                  ALTER COLUMN "targetBudget"      TYPE NUMERIC(14,2);
ALTER TABLE "dtp_consultations"            ALTER COLUMN "estimatedCost"     TYPE NUMERIC(14,2);
ALTER TABLE "dtp_participant_insurance"   ALTER COLUMN "coverageAmount"    TYPE NUMERIC(14,2);
ALTER TABLE "dtp_budget_line_items"        ALTER COLUMN "amount"            TYPE NUMERIC(14,2);
ALTER TABLE "family_law_assets"            ALTER COLUMN "estimatedValue"    TYPE NUMERIC(14,2);
ALTER TABLE "family_law_budget_line_items" ALTER COLUMN "amount"            TYPE NUMERIC(14,2);
ALTER TABLE "health_budget_line_items"     ALTER COLUMN "amount"            TYPE NUMERIC(14,2);

-- ── Полный аудит 2026-08-30 (вечер): юрисдикция для legal-disclaimer ──
-- User.country хранил название («Україна»), resolveJurisdictionBucket ждал
-- ISO-код → все пользователи попадали в OTHER. Два новых поля:
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "countryCode"   VARCHAR(2);  -- явно указанная / распознанная по названию
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ipCountryCode" VARCHAR(2);  -- x-vercel-ip-country, обновляется guard'ом
-- Backfill кода из уже сохранённых названий (те же соответствия, что в jurisdiction-bucket.ts):
UPDATE "users" SET "countryCode" = 'UA' WHERE "countryCode" IS NULL AND lower(trim("country")) IN ('україна','украина','ukraine');
UPDATE "users" SET "countryCode" = 'US' WHERE "countryCode" IS NULL AND lower(trim("country")) IN ('сша','united states','united states of america','usa');

-- ── grok-4 → grok-4.3 (retired-модель, по прямому запросу 2026-08-30) ──
-- xAI officially retired grok-4/grok-4-*/grok-3 on 2026-05-15; requests
-- silently redirect to grok-4.3 at grok-4.3 pricing. Обновляет уже
-- засеянные строки на проде (seed.ts upsert создал бы НОВУЮ строку с
-- новым id, не тронув старую grok-4 — этот UPDATE меняет её на месте,
-- чтобы существующие ссылки AIModelVersion.id в истории инференсов не
-- разошлись с активной моделью). Проверить перед применением, что в
-- проекте есть только один AIModel-ряд с name='grok-4' у провайдера xai.
UPDATE ai_models SET name = 'grok-4.3'
  WHERE name = 'grok-4' AND "providerId" = (SELECT id FROM ai_providers WHERE name = 'xai');
UPDATE ai_model_versions SET version = 'grok-4.3'
  WHERE version = 'grok-4' AND "modelId" IN (SELECT id FROM ai_models WHERE name = 'grok-4.3' AND "providerId" = (SELECT id FROM ai_providers WHERE name = 'xai'));
