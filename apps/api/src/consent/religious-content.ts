// Пункт [the-consent-that-stopped-nothing] 2026-09-30 — согласие,
// у которого не было ни одной проверки.
//
// НАЙДЕНО. `ConsentType.RELIGIOUS_CONTENT` во всём `apps/api/src`
// упоминался ровно дважды, и оба раза — ВЫДАЧА и ОТЗЫВ, а не проверка:
//
//   onboarding.service.ts:199 ensureReligiousContentConsent()  — создать при data.religion
//   onboarding.service.ts:217 revokeReligiousContentConsent()  — отозвать при religion = null
//
// Весь религиозный контент гейтился полем `User.religion`:
//
//   religious-reminder.service.ts      — `if (!user?.religion) return { shouldShow: false }`
//   situational-content.service.ts     — `assertReligionSet()`, читает только religion
//   reconciliation-arguments.service.ts — то же
//   closing-message.service.ts         — `!!user.religion`, и рядом комментарий,
//                                        который УТВЕРЖДАЕТ, что проверяет согласие:
//                                        «не персистим её, раз согласия на религиозный
//                                        контент не было»
//
// Следствие. Человек жмёт «отозвать» в Центре приватности, `revokedAt`
// проставляется, отчёт говорит «готово» — и напоминания о заповедях,
// цитаты, анекдоты и религиозные вставки в завершающее сообщение
// продолжают приходить, потому что `User.religion` никто не тронул.
// `REVOCATION_EFFECTS.RELIGIOUS_CONTENT.alsoDoes` равно `null`, а
// `doesNotUndo` говорит: «Настройки, которые вы указали при онбординге,
// остаются — их можно изменить там же». Буквально верно и вводит в
// заблуждение по сути: ИМЕННО ЭТИ НАСТРОЙКИ И БЫЛИ ВСЕМ ГЕЙТОМ.
//
// Сравните с тем, где отзыв работает: THIRD_PARTY_AUDIO_RECORDING
// обещает «новые разговоры начать будет нельзя» — и это правда,
// проверка стоит на каждом старте.
//
// ЧТО СДЕЛАНО. Одна функция вместо четырёх копий чтения `religion` —
// по той же причине, что `assertAudioMayLeaveDevice` и
// `timing-safe-equal`: копия проверки в каждом месте и есть причина,
// по которой часть мест остаётся без неё.
//
// ПОЧЕМУ НЕ «ОБНУЛЯТЬ religion ПРИ ОТЗЫВЕ». Это удалило бы то, что
// человек сам о себе сказал, ради выключения показа — несоразмерно, и
// повторное согласие потребовало бы вводить всё заново. Гейтом
// становится согласие, а `religion` остаётся его настройкой.

import { ConsentType } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import type { ConsentService } from './consent.service';
import type { PrismaService } from '../prisma/prisma.service';

/** Отказ человеку, когда вероисповедание не указано. Текст один на все
 * четыре места: он и был одинаковым по смыслу, но разным по словам. */
export const RELIGION_NOT_SET =
  'Функция доступна только тем, кто явно указал вероисповедание — его можно указать в анкете, и там же отказаться.';

/** Можно ли показывать религиозный контент: вероисповедание указано И
 * согласие на религиозный контент действует. Возвращает `religion`,
 * потому что вызывающему он нужен дальше, — чтобы не читать строку
 * пользователя дважды. */
export async function religiousContentAllowed(
  prisma: PrismaService,
  consent: ConsentService,
  userId: string,
  projectId?: string,
): Promise<{ allowed: boolean; religion: string | null }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { religion: true } });
  const religion = user?.religion ?? null;
  if (!religion) return { allowed: false, religion: null };
  const granted = await consent.hasActiveConsent(userId, ConsentType.RELIGIOUS_CONTENT, projectId);
  return { allowed: granted, religion };
}

/** То же, но для мест, где отсутствие права — отказ, а не пустой ответ.
 * `requireConsent` бросает 403 с кодом `CONSENT_REQUIRED` и типом
 * согласия, чтобы экран открыл ИМЕННО эту дверь, а не общую. */
export async function assertReligiousContentAllowed(
  prisma: PrismaService,
  consent: ConsentService,
  userId: string,
  projectId?: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { religion: true } });
  if (!user?.religion) throw new BadRequestException(RELIGION_NOT_SET);
  await consent.requireConsent(userId, ConsentType.RELIGIOUS_CONTENT, projectId);
  return user.religion;
}
