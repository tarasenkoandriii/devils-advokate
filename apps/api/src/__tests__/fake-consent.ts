// Пункт [consent-that-could-not-be-given] 2026-09-24 — одна заглушка
// согласий на все спеки, а не копия в каждой.
//
// Копий уже было две (chat-import и text-to-speech), и с новым контуром
// стало бы пять. Разъезжающиеся копии одной заботы — как раз то, чем
// этот ряд сверок занят: заглушка, забывшая бросить исключение, делает
// проверку согласия зелёной навсегда.

import { ForbiddenException } from '@nestjs/common';

export interface ConsentCall {
  userId: string;
  consentType: string;
  projectId?: string;
  purpose?: string;
}

export interface FakeConsentService {
  calls: ConsentCall[];
  requireConsent(userId: string, consentType: string, projectId?: string, purpose?: string): Promise<void>;
  hasActiveConsent(userId: string, consentType: string, projectId?: string, purpose?: string): Promise<boolean>;
}

/** `granted` — какие согласия считаются выданными. `true` (умолчание) —
 * все; список — только названные; `false` — ни одного. */
export function createFakeConsentService(
  options: { granted?: boolean | string[] } = {},
): FakeConsentService {
  const granted = options.granted ?? true;
  const has = (type: string) => (Array.isArray(granted) ? granted.includes(type) : granted);
  const calls: ConsentCall[] = [];
  return {
    calls,
    async requireConsent(userId, consentType, projectId, purpose) {
      calls.push({ userId, consentType, projectId, purpose });
      if (!has(consentType)) {
        // Тот же код, что у настоящего сервиса: экран опознаёт ситуацию
        // по нему, а не по тексту.
        throw new ForbiddenException({
          message: 'Для этого действия нужно ваше согласие — его спросят перед тем, как продолжить.',
          code: 'CONSENT_REQUIRED',
          consentType,
        });
      }
    },
    async hasActiveConsent(userId, consentType, projectId, purpose) {
      calls.push({ userId, consentType, projectId, purpose });
      return has(consentType);
    },
  };
}
