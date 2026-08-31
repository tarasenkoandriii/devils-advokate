// Generic-клиент доменных конвейеров — маршруты берутся из манифеста.
import { apiGet, apiPost, apiPatch } from '../api';
import { DomainManifest } from './types';

export interface DomainProjectItem { id: string; question: string; mode: string; createdAt: string; updatedAt: string }
export interface DomainProjectList { items: DomainProjectItem[]; total: number; take: number; skip: number }
export interface OnboardingAnswers { id: string; projectId: string; status: string; answers: Array<{ id: string; text: string; orderMs: number }> }

export const domainApi = {
  listProjects: (m: DomainManifest) => apiGet<DomainProjectList>(m.routes.listProjects),
  createProject: (m: DomainManifest, body: Record<string, unknown>) => apiPost<DomainProjectItem>(m.routes.createProject, body),
  createOnboarding: (m: DomainManifest, projectId: string) =>
    apiPost<{ conversation: { id: string } }>(m.routes.createOnboarding(projectId), {}),
  getOnboarding: (m: DomainManifest, conversationId: string) => apiGet<OnboardingAnswers>(m.routes.getOnboarding(conversationId)),
  appendAnswer: (m: DomainManifest, conversationId: string, text: string) =>
    apiPost<{ id: string; text: string }>(m.routes.appendAnswer(conversationId), { text }),
  extract: (m: DomainManifest, conversationId: string) => apiPost<Record<string, any>>(m.routes.extract(conversationId), {}),
  checklist: (m: DomainManifest, conversationId: string, query?: Record<string, string>) => {
    if (!m.routes.checklist) return Promise.resolve(null);
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return apiGet<any>(`${m.routes.checklist(conversationId)}${qs}`);
  },
  createConfig: (m: DomainManifest, projectId: string, draft: Record<string, unknown>) =>
    apiPost<Record<string, any>>(m.routes.createConfig(projectId), draft),
  getConfig: (m: DomainManifest, projectId: string) => apiGet<Record<string, any> | null>(m.routes.getConfig(projectId)),
  getJson: (route: string) => apiGet<any>(route),
  postJson: (route: string, body: Record<string, unknown>) => apiPost<any>(route, body),
  patchJson: (route: string, body: Record<string, unknown>) => apiPatch<any>(route, body),
};
