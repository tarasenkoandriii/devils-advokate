// Пункт 56 (backend) → TMA UI: клиент для ПУБЛИЧНОЙ (не Telegram-
// аутентифицированной) стороны обсуждения (§4.5 ТЗ). Намеренно НЕ
// использует apiGet/apiPost из api.ts — те вызывают getAuthHeaders(),
// которая ПАДАЕТ вне Telegram WebApp-контекста (см. telegram.ts) —
// именно тот случай, когда кто-то открывает публичную ссылку в
// обычном браузере, не внутри Telegram. Переиспользует только
// handle() (разбор конверта ответа), не заголовки авторизации.

import { handle } from './api';
import { PublicDiscussionView, PublicParticipant, PublicArgumentSubmission, LibraryEntry, LibraryExperience, ApprovedVenue } from './types';

// Пункт [green-deploy-pointed-at-localhost] 2026-09-30: адрес API —
// одно место на приложение, с проверкой на платформе.
import { API_BASE_URL } from './api-base-url';

async function publicReq<T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(response);
}

// Пункт [badge-was-the-key] 2026-09-24: `participantId` уходит на сервер
// только чтобы тот отметил «это моё». Удостоверением он больше не
// является — и обратно ни в одном списке не приходит.
export function getPublicDiscussion(token: string, participantId?: string | null): Promise<PublicDiscussionView> {
  const suffix = participantId ? `?participantId=${encodeURIComponent(participantId)}` : '';
  return publicReq<PublicDiscussionView>(`/public/${token}${suffix}`);
}

export function joinPublicDiscussion(token: string, displayName?: string): Promise<PublicParticipant> {
  return publicReq<PublicParticipant>(`/public/${token}/participants`, 'POST', { displayName });
}

export function submitPublicArgument(
  token: string,
  text: string,
  stance: 'PRO' | 'CON',
  participantId?: string,
): Promise<PublicArgumentSubmission> {
  return publicReq<PublicArgumentSubmission>(`/public/${token}/submissions`, 'POST', { text, stance, participantId });
}

export function votePublicSubmission(token: string, submissionId: string, direction: 'up' | 'down'): Promise<PublicArgumentSubmission> {
  return publicReq<PublicArgumentSubmission>(`/public/${token}/submissions/${submissionId}/vote`, 'POST', { direction });
}

/** Пункт [public-name] 2026-09-05 — забрать своё. Участник опознаётся
 * по собственному удостоверению: заводить аккаунт ради права забрать
 * своё значило бы поставить условие вместо права.
 *
 * ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24: удостоверением был
 * `participantId`, который публичная страница печатала всем. Теперь —
 * `withdrawToken`, выданный один раз при входе. */
export function withdrawPublicComment(token: string, commentId: string, withdrawToken: string): Promise<{ deleted: true }> {
  return publicReq<{ deleted: true }>(`/public/${token}/comments/${commentId}`, 'DELETE', { withdrawToken });
}

export function withdrawPublicSubmission(token: string, submissionId: string, withdrawToken: string): Promise<{ deleted: true }> {
  return publicReq<{ deleted: true }>(`/public/${token}/submissions/${submissionId}`, 'DELETE', { withdrawToken });
}

// Возвращается только id созданного: страница всё равно перечитывает
// список, а лишние поля в ответе — это лишние поля наружу.
export function addPublicComment(token: string, text: string, participantId?: string): Promise<{ id: string }> {
  return publicReq<{ id: string }>(`/public/${token}/comments`, 'POST', { text, participantId });
}

// Пункт 57 (backend) — Library (§3.5 ТЗ), публичная сторона. НЕ
// использует токен проекта — это отдельная, общая для всех
// пользователей библиотека, не привязанная к одному обсуждению.

export function browseLibrary(category?: string): Promise<LibraryEntry[]> {
  const query = category ? `?category=${encodeURIComponent(category)}` : '';
  return publicReq<LibraryEntry[]>(`/public/library${query}`);
}

export function getLibraryEntry(entryId: string): Promise<LibraryEntry> {
  return publicReq<LibraryEntry>(`/public/library/${entryId}`);
}

export function voteLibraryEntry(entryId: string, direction: 'up' | 'down'): Promise<LibraryEntry> {
  return publicReq<LibraryEntry>(`/public/library/${entryId}/vote`, 'POST', { direction });
}

export function addLibraryExperience(entryId: string, text: string, authorDisplayName?: string): Promise<LibraryExperience> {
  return publicReq<LibraryExperience>(`/public/library/${entryId}/experiences`, 'POST', { text, authorDisplayName });
}

// Пункт 66 (backend) — Venue Application (§3.23 ТЗ), публичная сторона
// (каталог одобренных заведений).

export function browseApprovedVenues(): Promise<ApprovedVenue[]> {
  return publicReq<ApprovedVenue[]>('/public/venues');
}

export function getApprovedVenue(id: string): Promise<ApprovedVenue> {
  return publicReq<ApprovedVenue>(`/public/venues/${id}`);
}

// Пункт [job-domain-v2] — публичные экраны найма: преданкета кандидата (А-2) и
// согласование текста вакансии заказчиком (А-18). Оба открываются вне
// Telegram — тот же публичный клиент без initData.
export interface PreQuestionnaireForm {
  jobTitle: string | null;
  company: string | null;
  questions: Array<{ id: string; text: string }>;
  consents: { aiNotice: string; transfer: string };
  answered: boolean;
  expiresAt: string;
  /** Пункт [candidate-rights] 2026-09-04 — согласие уже отозвано. */
  consentRevokedAt: string | null;
}

/** Что отзыв сделал и чего НЕ сделал. Второе — обязательная половина:
 * «отозвано» без перечня последствий человек читает как «стёрлось всё». */
export interface CandidateRevocation {
  consentRevokedAt: string;
  alreadyRevoked: boolean;
  sharesRevoked: number;
  // Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25: сервер
  // считал их с самого начала, а тип клиента о них не знал — значит, и
  // экран не мог их показать. `depthExhausted` здесь важнее счётчиков:
  // это «мы дошли не до конца», и человеку, только что отозвавшему
  // согласие, это самая существенная новость из трёх.
  copiesRevoked: number;
  depthExhausted: boolean;
  alsoDone: string;
  doesNotUndo: string;
}

/** Отзыв согласия САМИМ кандидатом — по тому же токену, что и анкета.
 * Аккаунта у него нет, и другого способа воспользоваться обещанным
 * правом у него тоже нет. */
export function revokePreQuestionnaireConsent(token: string): Promise<CandidateRevocation> {
  return publicReq<CandidateRevocation>(`/pre-questionnaire/${encodeURIComponent(token)}/revoke-consent`, 'POST', {});
}

export function getPreQuestionnaire(token: string): Promise<PreQuestionnaireForm> {
  return publicReq<PreQuestionnaireForm>(`/pre-questionnaire/${encodeURIComponent(token)}`);
}

export function submitPreQuestionnaire(
  token: string,
  body: { aiNoticeAccepted: boolean; transferConsentAccepted: boolean; answers: Array<{ questionId: string; text: string }> },
): Promise<{ ok: boolean; answers: number; proposedPositions: number; note: string }> {
  return publicReq(`/pre-questionnaire/${encodeURIComponent(token)}`, 'POST', body);
}

export interface PostingReviewView {
  text: string;
  expiresAt: string;
  origins: Array<{ text: string; label: string; briefQuote: string | null }>;
  comments: Array<{ at: string; text: string }>;
}

export function getPostingReview(token: string): Promise<PostingReviewView> {
  return publicReq<PostingReviewView>(`/posting-review/${encodeURIComponent(token)}`);
}

export function commentPostingReview(token: string, text: string): Promise<unknown> {
  return publicReq(`/posting-review/${encodeURIComponent(token)}/comments`, 'POST', { text });
}
