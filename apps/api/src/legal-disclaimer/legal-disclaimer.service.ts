// Пункт [investment] §10.3 ТЗ.
//
// ЗМІНЕНО ЗА ПРЯМИМ ЗАПИТОМ (первинна поведінка §10.4 документа —
// явний isResearched-прапорець із текстом "не досліджено, зверніться
// до юриста" — навмисно замінена на структурне приховання). Ризик
// цього рішення був названий явно й підтверджений користувачем:
// мовчання про юрисдикцію можна прочитати як "тут нема юридичних
// ризиків", хоча насправді просто ніхто не досліджував — саме ця
// різниця й була причиною початкового явного прапорця. Рішення
// прийняте свідомо, не тихий відкат.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectMode } from '@prisma/client';
import { countryNameToCode, resolveJurisdictionBucket } from './jurisdiction-bucket';
import { LEGAL_REFERENCE_SEED, LegalReference } from './legal-reference-seed';
import type { JurisdictionBucket } from './jurisdiction-bucket';

/** Пункт [silent-jurisdiction] 2026-09-06 — см. ниже, почему `null`
 * больше не возвращается. */
export type LegalCoverage =
  /** Для этой пары «режим + юрисдикция» ссылки собраны. */
  | 'seeded'
  /** Пара не разбиралась вовсе. НЕ «разобрали и норм не нашли»:
   * различить это в нынешнем словаре нечем, и выдавать одно за другое
   * — ровно тот изъян, который пункт закрывает. */
  | 'not-researched';

export interface LegalDisclaimerResponse {
  bucket: string;
  references: LegalReference[];
  coverage: LegalCoverage;
  /** Сколько дней прошло с даты, когда ссылки вписали в продукт.
   * Считается сервером: экран, считающий возраст сам, однажды посчитает
   * иначе. `null`, когда ссылок нет. */
  seededDaysAgo: number | null;
}

/** Всего пар «режим × юрисдикция» и сколько из них собрано — считается
 * из самого словаря, а не записано числом: число разошлось бы со
 * словарём при первом же пополнении. */
/** Возраст списка — по САМОЙ СТАРОЙ ссылке: список настолько свеж,
 * насколько свежа его худшая строка. Считать по самой новой значило бы
 * прятать старую норму за свежей соседкой.
 *
 * Вынесено отдельной функцией не ради красоты: пока в словаре у каждой
 * собранной пары даты совпадают, правило «берём самую старую»
 * невозможно проверить на самих данных — мутация «берём самую новую»
 * проходила насквозь. Проверка должна держаться и тогда, когда данные
 * ещё не успели стать разнородными. */
export function oldestSeededDaysAgo(references: readonly LegalReference[], now: Date): number | null {
  if (references.length === 0) return null;
  const oldest = references.reduce((acc, r) => (r.seededAt < acc ? r.seededAt : acc), references[0].seededAt);
  const days = Math.floor((now.getTime() - new Date(oldest).getTime()) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

export function seedCoverageSummary(): { total: number; seeded: number } {
  let total = 0;
  let seeded = 0;
  for (const mode of Object.keys(LEGAL_REFERENCE_SEED) as ProjectMode[]) {
    for (const bucket of Object.keys(LEGAL_REFERENCE_SEED[mode]) as JurisdictionBucket[]) {
      total++;
      if (LEGAL_REFERENCE_SEED[mode][bucket].length > 0) seeded++;
    }
  }
  return { total, seeded };
}

@Injectable()
export class LegalDisclaimerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пункт [silent-jurisdiction] 2026-09-06 — здесь возвращался `null`,
   * и это было названо «структурним сигналом»: экран делал
   * `if (!data) return null` и блок о законе исчезал целиком.
   *
   * МЕРИЛИ: из 32 пар «режим × юрисдикция» собраны ЧЕТЫРЕ. Остальные 28
   * — включая ДТП в Украине, семейное право в Украине, все домены
   * здоровья и поиска работы — отдавали `null`, то есть пустой экран
   * без единого слова. Для украинского пользователя, ради которого
   * продукт и сделан, блок о законе не показывался почти никогда.
   *
   * ПОЧЕМУ ЭТО МЕНЯЕТСЯ, ХОТЯ РЕШЕНИЕ БЫЛО ПРИНЯТО ОСОЗНАННО. Прежний
   * комментарий здесь честно называл риск: «мовчання про юрисдикцію
   * можна прочитати як „тут нема юридичних ризиків“, хоча насправді
   * просто ніхто не досліджував». Риск назван верно — и реализован
   * буквально. С тех пор тот же продукт закрыл этот изъян везде, где
   * нашёл, и даже СБОЙ загрузки этого самого блока получил отдельное
   * сообщение (`SectionLoadError`, аудит 2026-09-03) именно с доводом
   * «юридические ориентиры, исчезнувшие молча, читаются как „этот домен
   * ничем не регулируется“». Пробел и сбой здесь — одна и та же ложь
   * умолчанием, и закрывать одну, оставляя другую на том же экране,
   * непоследовательно.
   *
   * ЧТО СОХРАНЕНО ОТ ПРЕЖНЕГО РЕШЕНИЯ: отвергнут был пугающий флаг
   * «не досліджено, зверніться до юриста» на каждом экране. Его здесь
   * нет и не появляется — есть спокойный факт о том, чего продукт не
   * собрал. */
  async getDisclaimer(userId: string, mode: ProjectMode, now = new Date()): Promise<LegalDisclaimerResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { country: true, countryCode: true, ipCountryCode: true } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    // Явно указанная страна → распознанное название → страна по IP (Vercel).
    const explicit = user.countryCode ?? countryNameToCode(user.country);
    const bucket = resolveJurisdictionBucket(explicit ?? user.ipCountryCode, user.country);
    const references = LEGAL_REFERENCE_SEED[mode][bucket];
    if (references.length === 0) {
      return { bucket, references: [], coverage: 'not-researched', seededDaysAgo: null };
    }
    return { bucket, references, coverage: 'seeded', seededDaysAgo: oldestSeededDaysAgo(references, now) };
  }
}
