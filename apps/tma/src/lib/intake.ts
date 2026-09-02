// ТЗ domain-ui-and-voice-intake §2 — клиент intake-квиза.
import { apiGet, apiPost } from './api';
import { DomainId } from './domains/types';

export type IntakeScenario = 'UNIVERSAL' | DomainId;
export interface IntakeDecision { scenario: IntakeScenario; suggestedScenario: IntakeScenario; confidence: number; belowThreshold: boolean }
export interface IntakeExtracted { question: string; goal: string | null; facts: string[]; contractType: 'PRENUP' | 'DIVORCE_SETTLEMENT' | null }
export interface IntakeSessionView {
  id: string; status: 'IN_PROGRESS' | 'DISPATCHED' | 'ABANDONED';
  answers: Array<{ question: string | null; text: string; at: string }>;
  followUpsAsked: number; followUpsLeft: number;
  nextQuestion: string | null; decision: IntakeDecision | null; extracted: IntakeExtracted | null;
  chosenScenario: IntakeScenario | null; dispatchedProjectId: string | null;
}
export interface IntakeDispatchResult extends IntakeSessionView { projectId: string; conversationId: string | null }

export const intakeApi = {
  // Пункт [job-landing-attribution] 2026-09-02: метка источника с
  // лендинга уходит вместе с первым ответом (§4 ТЗ job-landing).
  start: (text: string, attribution?: { source?: string; campaign?: string }) =>
    apiPost<IntakeSessionView>('/intake/sessions', {
      text,
      ...(attribution?.source ? { source: attribution.source } : {}),
      ...(attribution?.campaign ? { campaign: attribution.campaign } : {}),
    }),
  answer: (id: string, text: string) => apiPost<IntakeSessionView>(`/intake/sessions/${id}/answers`, { text }),
  get: (id: string) => apiGet<IntakeSessionView>(`/intake/sessions/${id}`),
  dispatch: (id: string, scenario: IntakeScenario, contractType?: 'PRENUP' | 'DIVORCE_SETTLEMENT') =>
    apiPost<IntakeDispatchResult>(`/intake/sessions/${id}/dispatch`, { scenario, contractType }),
};
