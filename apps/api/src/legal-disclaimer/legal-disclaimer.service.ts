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

export interface LegalDisclaimerResponse {
  bucket: string;
  references: LegalReference[]; // завжди непорожній, коли відповідь не null
}

@Injectable()
export class LegalDisclaimerService {
  constructor(private readonly prisma: PrismaService) {}

  /** null — структурний сигнал "нічого не знайдено для цієї
   * юрисдикції+режиму", не окреме поле, яке фронтенд міг би забути
   * перевірити. Природний `if (response)` на фронтенді ховає
   * дисклеймер сам по собі. */
  async getDisclaimer(userId: string, mode: ProjectMode): Promise<LegalDisclaimerResponse | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { country: true, countryCode: true, ipCountryCode: true } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    // Явно указанная страна → распознанное название → страна по IP (Vercel).
    const explicit = user.countryCode ?? countryNameToCode(user.country);
    const bucket = resolveJurisdictionBucket(explicit ?? user.ipCountryCode, user.country);
    const references = LEGAL_REFERENCE_SEED[mode][bucket];
    if (references.length === 0) {
      return null;
    }
    return { bucket, references };
  }
}
