// Пункт 56 (backend) → TMA UI: клиент для ПУБЛИЧНОЙ (не Telegram-
// аутентифицированной) стороны обсуждения (§4.5 ТЗ). Намеренно НЕ
// использует apiGet/apiPost из api.ts — те вызывают getAuthHeaders(),
// которая ПАДАЕТ вне Telegram WebApp-контекста (см. telegram.ts) —
// именно тот случай, когда кто-то открывает публичную ссылку в
// обычном браузере, не внутри Telegram. Переиспользует только
// handle() (разбор конверта ответа), не заголовки авторизации.

import { handle } from './api';
import { PublicDiscussionView, PublicParticipant, PublicArgumentSubmission, PublicComment, LibraryEntry, LibraryExperience, ApprovedVenue } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

async function publicReq<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(response);
}

export function getPublicDiscussion(token: string): Promise<PublicDiscussionView> {
  return publicReq<PublicDiscussionView>(`/public/${token}`);
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

export function addPublicComment(token: string, text: string, participantId?: string): Promise<PublicComment> {
  return publicReq<PublicComment>(`/public/${token}/comments`, 'POST', { text, participantId });
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
