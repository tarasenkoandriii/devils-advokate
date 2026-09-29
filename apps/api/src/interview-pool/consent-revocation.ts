// Пункт [job-domain-v2] А-6 / приёмка 27 — отзыв согласия кандидата как
// ОДНО правило, а не как отдельная проверка в каждом месте.
//
// НАЙДЕНО АУДИТОМ 2026-09-03 (сверка реестра §12 с кодом). `consentRevokedAt`
// писался ровно в одном месте (самошеринг соискателя) и читался ровно в двух
// (матрица покрытия и перенос кандидата в другой проект). Всё остальное —
// отчёт по кандидату, сводный отчёт заказчику, снимок релевантности,
// доставка отчёта работодателю — читало кандидатов запросом без единого
// упоминания отзыва. То есть человек отзывал согласие, а его разбор
// продолжал уходить наружу: это не косметика, а ровно тот случай, ради
// которого поле и заводилось.
//
// ГРАНИЦА, ВЫБРАННАЯ ОСОЗНАННО. Отзыв исключает кандидата из всего, что
// ПОКИДАЕТ проект или ПЕРЕСОБИРАЕТСЯ (отчёты, доставки, снимки), но НЕ
// прячет его из внутренних списков рекрутера: исчезнувший без следа человек
// выглядит как сбой продукта, а не как исполненная воля кандидата. В списке
// он остаётся с отметкой, и там же видно, почему по нему ничего не
// генерируется.

import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const CONSENT_REVOKED_MESSAGE =
  'Кандидат отозвал согласие на обработку — по нему не формируются отчёты и разборы, и уже готовые не доставляются. Отзыв снимает только сам кандидат.';

/** Отозвано ли согласие у кандидата за этой строкой пула.
 *
 * Фильтр в памяти, а не отдельный запрос с вложенным условием: все три места
 * (отчёт по кандидату, сводный отчёт, снимок релевантности) и так загружают
 * статусы вместе с профилем — лишний запрос ради того же значения только
 * добавил бы способ разойтись с ним. */
export function consentRevoked(status: { candidateProfile?: { consentRevokedAt?: Date | null } | null }): boolean {
  return !!status.candidateProfile?.consentRevokedAt;
}

/** 403 по конкретному кандидату — там, где действие адресное.
 *
 * Пункт [revocation-not-one-rule] 2026-09-06: эта функция была написана
 * прошлой сверкой и НЕ ВЫЗЫВАЛАСЬ НИ ОТКУДА. Оба адресных места
 * (добавление кандидата в пул и добавление существующего кандидата в
 * проект) читали флаг сами, и одно из них при этом сообщало человеку
 * СВОЙ текст — «Согласие кандидата отозвано», без главного: что
 * отчёты по кандидату не формируются и что снять отзыв может только
 * сам кандидат. Рекрутер, прочитавший короткую версию, идёт просить
 * коллегу добавить кандидата соседней кнопкой — то есть текст не
 * просто беднее, он ведёт не туда.
 *
 * Файл заводился ровно с целью «отзыв — ОДНО правило, а не проверка в
 * каждом месте» (см. заголовок выше), и правило разъехалось в том же
 * файле, где объявлено. */
export async function assertConsentActive(prisma: PrismaService, candidateProfileId: string): Promise<void> {
  const profile = await prisma.candidateProfile.findUnique({
    where: { id: candidateProfileId },
    select: { consentRevokedAt: true },
  });
  if (profile?.consentRevokedAt) throw new ForbiddenException(CONSENT_REVOKED_MESSAGE);
}

/** Кандидаты, упомянутые в содержимом отчёта: адресный — по полю,
 * сводный — по entries. Нужен доставке (§11.27: отзыв останавливает и её). */
export function candidateIdsInReport(report: { candidateProfileId: string | null; content: unknown }): string[] {
  const ids: string[] = [];
  if (report.candidateProfileId) ids.push(report.candidateProfileId);
  const entries = (report.content as { entries?: Array<{ candidateProfileId?: unknown }> } | null)?.entries;
  if (Array.isArray(entries)) {
    for (const e of entries) if (typeof e?.candidateProfileId === 'string') ids.push(e.candidateProfileId);
  }
  return [...new Set(ids)];
}

/** Отметка для СПИСКОВ рекрутера. Пункт [revocation-not-one-rule]
 * 2026-09-06: граница, выбранная этим файлом, сказана в его заголовке
 * прямым текстом — «отзыв ... НЕ прячет кандидата из внутренних
 * списков рекрутера: исчезнувший без следа человек выглядит как сбой
 * продукта, а не как исполненная воля кандидата. В списке он остаётся
 * с отметкой».
 *
 * Матрица покрытия кандидатов эту границу нарушала: строка кандидата
 * просто пропускалась (`continue`), без строки и без счётчика. Человек
 * исчезал из таблицы бесследно — ровно то, что файл запрещает. Теперь
 * строка остаётся, и вот эта отметка объясняет, почему она пустая. */
export const CONSENT_REVOKED_ROW_NOTE =
  'Кандидат отозвал согласие — покрытие требований по нему не пересобирается. Строка оставлена намеренно: исчезнувший без следа человек выглядел бы как сбой продукта, а не как исполненная воля кандидата.';

// ── Пункт [copy-outlived-consent] 2026-09-24 ──
//
// НАЙДЕНО СРАВНЕНИЕМ ДВУХ ОТЗЫВОВ. Отозвать согласие кандидата можно
// двумя дорогами, и они расходились ровно в том, что для кандидата
// важнее всего:
//
//  • САМОШЕРИНГ (`CandidateSelfShareService.revoke`) — гасит ссылку И
//    ставит `consentRevokedAt` КОПИИ, созданной у принимающей стороны;
//  • РЕКРУТЕРСКИЙ ОТЗЫВ (`revokeConsent`) — ставит отметку исходному
//    профилю и гасит строки шеринга, а КОПИИ НЕ ТРОГАЕТ ВОВСЕ.
//
// Что это значит на деле. Кандидат просит рекрутера: «уберите мои
// данные». Рекрутер нажимает кнопку, продукт отвечает «отзыв записан».
// Исходный профиль помечен, живые ссылки погашены — но копия, уже
// принятая другим агентством или работодателем в СВОЙ проект, остаётся
// с `consentRevokedAt: null`. Там `assertConsentActive` проходит, и по
// этому человеку продолжают формироваться отчёты, сводки и доставки —
// то самое, ради чего поле и заводилось (см. шапку файла).
//
// И комментарий над `revokeConsent` обещал прямо: «Вместе с профилем
// гасятся все живые ссылки на него». Ссылки — да. Принятые копии —
// нет, и о них не было сказано ничего.
//
// ПОЧЕМУ ТРАНЗИТИВНО. Принявший копию владеет ею и может поделиться ею
// дальше — тогда появляется копия копии. Гасить один уровень значило бы
// починить ближний случай и оставить дальний, то есть повторить тот же
// изъян на шаг глубже. Обход идёт по родословной шерингов.
//
// ПОТОЛОК ГЛУБИНЫ — не перестраховка, а защита от цикла: `A → B → A`
// в данных ничем не запрещён, и обход без потолка на таком графе не
// закончится никогда. Достигнутый потолок ВОЗВРАЩАЕТСЯ НАРУЖУ числом, а
// не проглатывается: сказать «отозвано везде», не дойдя до конца, —
// ровно та неправда, которую этот пункт убирает.

/** Сколько уровней «копия копии» проходится. Десять — заведомо больше
 * любой реальной цепочки передач, и при этом конечно. */
export const MAX_COPY_CHAIN_DEPTH = 10;

export interface ConsentRevocationCascade {
  /** Профили, которым проставлен `consentRevokedAt` (включая исходный). */
  profilesRevoked: number;
  /** Строки шеринга, погашенные по дороге. */
  sharesRevoked: number;
  /** Обход упёрся в потолок глубины: часть копий могла остаться. */
  depthExhausted: boolean;
}

/** Отзыв согласия по всей родословной копий — одна дорога для обоих
 * маршрутов отзыва. */
export async function revokeConsentCascade(
  prisma: PrismaService,
  rootProfileId: string,
  now: Date,
): Promise<ConsentRevocationCascade> {
  let profilesRevoked = 0;
  let sharesRevoked = 0;
  let frontier = [rootProfileId];
  const seen = new Set<string>([rootProfileId]);
  let depth = 0;

  while (frontier.length > 0 && depth < MAX_COPY_CHAIN_DEPTH) {
    const marked = await prisma.candidateProfile.updateMany({
      where: { id: { in: frontier }, consentRevokedAt: null },
      data: { consentRevokedAt: now },
    });
    profilesRevoked += marked.count;

    // Ссылки, ведущие ОТ этих профилей и К ним: первые надо погасить,
    // вторые дают следующий уровень копий.
    const shares = await prisma.candidateShare.findMany({
      where: { OR: [{ sourceCandidateId: { in: frontier } }, { createdCandidateProfileId: { in: frontier } }] },
      select: { id: true, createdCandidateProfileId: true, revokedAt: true },
    });
    const toRevoke = shares.filter((s) => !s.revokedAt).map((s) => s.id);
    if (toRevoke.length > 0) {
      const done = await prisma.candidateShare.updateMany({ where: { id: { in: toRevoke } }, data: { revokedAt: now } });
      sharesRevoked += done.count;
    }

    const next: string[] = [];
    for (const s of shares) {
      const id = s.createdCandidateProfileId;
      if (id && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    frontier = next;
    depth++;
  }

  return { profilesRevoked, sharesRevoked, depthExhausted: frontier.length > 0 };
}
