// Доменная вёрстка ДТП (образец для остальных доменов) — типы ответов
// backend по контроллеру dtp.controller.ts / dtp.service.ts / dtp-v2.service.ts.
// Общие для dtp/family-law/health типы (консультации, сравнение, сверка,
// бюджет) — в shared/ConsultationPipeline.tsx.
export type DtpCriterionCategory = 'FAULT_DETERMINATION' | 'DAMAGE_AND_REPAIR' | 'INSURANCE_COVERAGE' | 'OTHER';
export type DtpParticipantRole = 'SELF' | 'OTHER_PARTY' | 'THIRD_PARTY';
export type CrossConsultationStatus = 'NO_DISCREPANCY_FOUND' | 'DISCREPANCY_FOUND' | 'INSUFFICIENT_DATA';

export interface DtpCriterion { id: string; text: string; category: DtpCriterionCategory; isRequired: boolean; orderIndex: number }
export interface DtpConfig { id: string; projectId: string; goalDescription: string; targetBudget: number | null; currency: string | null; occurredAt: string | null; criteria: DtpCriterion[] }
export interface DtpAdvisor { id: string; label: string; advisorName: string | null; role: string | null }
export interface DtpParticipantInsurance { hasInsurance: boolean; insurerName: string | null; policyType: string | null; coverageAmount: number | null; currency: string | null }
export interface DtpParticipant { id: string; role: DtpParticipantRole; displayName: string | null; hasFledScene: boolean; insurance?: DtpParticipantInsurance | null }
export interface DtpFaultDetermination { id: string; source: string; statusText: string; determinedAt: string; isOfficial: boolean; referenceDocumentNumber: string | null }
export interface DtpEvidenceItem { id: string; mediaType: 'PHOTO' | 'VIDEO'; hasAudio: boolean; blobUrl: string | null; fileHash: string; capturedAt: string; latitude: number | null; longitude: number | null; createdAt: string }
export interface DtpEvidenceAccess { id: string; userId: string; occurredAt: string }

export const CATEGORY_LABEL: Record<DtpCriterionCategory, string> = { FAULT_DETERMINATION: 'Вина', DAMAGE_AND_REPAIR: 'Ущерб и ремонт', INSURANCE_COVERAGE: 'Страховое покрытие', OTHER: 'Прочее' };
export const ROLE_LABEL: Record<DtpParticipantRole, string> = { SELF: 'Я', OTHER_PARTY: 'Другая сторона', THIRD_PARTY: 'Третье лицо' };
export const BUDGET_CATEGORY_LABEL: Record<string, string> = { REPAIR: 'Ремонт', LEGAL_FEES: 'Юристы', INSURANCE_DEDUCTIBLE: 'Франшиза', MEDICAL: 'Медицина', OTHER: 'Прочее' };
export const CROSS_LABEL: Record<CrossConsultationStatus, { text: string; tone: 'ok' | 'bad' | 'muted' }> = {
  NO_DISCREPANCY_FOUND: { text: 'Расхождений нет', tone: 'ok' },
  DISCREPANCY_FOUND: { text: 'Расхождение', tone: 'bad' },
  INSUFFICIENT_DATA: { text: 'Мало данных', tone: 'muted' },
};

// Пункт [the-formatter-lived-in-someone-elses-domain] 2026-10-01: сами
// функции переехали в `lib/format.ts` — формат денег и дат принадлежит
// продукту, а не домену ДТП, и импортировали их отсюда семь не-ДТП
// экранов. Реэкспорт оставлен, чтобы ни один существующий импорт не
// ломался; доменные подписи ниже остаются здесь, на своём месте.
export { money, dateTime, dateOnly } from '../../../lib/format';
export const FAULT_SOURCE_LABEL: Record<string, string> = { POLICE: 'Полиция', INSURANCE_COMPANY: 'Страховая', COURT: 'Суд', MUTUAL_AGREEMENT: 'Взаимное соглашение', UNDETERMINED: 'Не определено' };
