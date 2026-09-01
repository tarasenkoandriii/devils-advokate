// Пункт [investment] §10.2/10.4 ТЗ — статичний словник, редагується
// людиною через code review, НЕ AI-генерація (юридичні факти — не той
// клас контенту, де прийнятне AI-судження, коли існує надійне
// детерміноване джерело). Зміст summary — не вигаданий заради
// заповнення таблиці, узятий з дослідження, вже проведеного й
// зафіксованого в devils-advocate-interview-pool-tz.md §2.1/2.2 та
// devils-advocate-investment-tz.md §2.1/2.2/2.3.

import { ProjectMode } from '@prisma/client';
import { JurisdictionBucket } from './jurisdiction-bucket';

export interface LegalReference {
  actName: string;
  citation: string;
  summary: string;
  sourceUrl?: string;
  lastVerifiedAt: string; // ISO-дата — НЕ "завжди актуально", чесна позначка застарівання
}

export const LEGAL_REFERENCE_SEED: Record<ProjectMode, Record<JurisdictionBucket, LegalReference[]>> = {
  INTERVIEW_POOL: {
    EU: [
      {
        actName: 'EU AI Act',
        citation: 'Annex III (recruitment/selection)',
        summary:
          'Найм прямо названий high-risk категорією AI. Обов\'язки для standalone Annex III систем відсунуті Digital Omnibus on AI з 2 серпня 2026 на 2 грудня 2027 — заборонені практики (Article 5) та обов\'язки з AI-грамотності діють з лютого 2025 без відстрочки.',
        lastVerifiedAt: '2026-01-15',
      },
    ],
    US: [
      {
        actName: 'NYC Local Law 144',
        citation: '§20-870 NYC Administrative Code',
        summary:
          'Діє з 1 січня 2023, примусове виконання з 5 липня 2023. Застосовується екстериторіально до кандидатів-резидентів NYC незалежно від реєстрації роботодавця. Діє ТІЛЬКИ для резидентів NYC — інші штати (Illinois, Colorado) мають окремі, не досліджені тут закони.',
        lastVerifiedAt: '2026-01-15',
      },
    ],
    UA: [],
    OTHER: [],
  },
  INVESTMENT: {
    US: [
      {
        actName: 'Investment Advisers Act of 1940',
        citation: '15 U.S.C. § 80b',
        summary:
          'Реєстрація як Registered Investment Adviser вимагається при отриманні компенсації САМЕ за пораду про securities, не за софт як інструмент. Fiduciary duty застосовується до RIA незалежно від участі AI у формуванні поради (SEC 2026 Exam Priorities).',
        lastVerifiedAt: '2026-01-15',
      },
      {
        actName: 'SEC Investment Clubs guidance',
        citation: 'sec.gov/answers/clubs.htm',
        summary:
          'Класичний investment club (спільний рахунок) може підпадати під реєстрацію як securities, якщо є пасивні учасники. Self-directed club (кожен інвестує окремо, гроші не об\'єднуються) — окремий, безпечніший варіант.',
        lastVerifiedAt: '2026-01-15',
      },
    ],
    EU: [
      {
        actName: 'MiFID II',
        citation: 'Directive 2014/65/EU, Article 4(4); ESMA 2023 Supervisory Briefing',
        summary:
          'Investment advice = personal recommendation щодо КОНКРЕТНИХ інструментів, побудована на особистих обставинах. Загальна порада про категорію інструментів — поза дією. ESMA розширила визначення на непрямі/імпліцитні рекомендації, включно з сортуванням "релевантніші зверху".',
        lastVerifiedAt: '2026-01-15',
      },
    ],
    UA: [],
    OTHER: [],
  },
  MAJOR_PURCHASE: {
    US: [], EU: [], UA: [], OTHER: [], // чесно порожньо для ВСІХ бакетів — розділ 10.4 ТЗ
  },
  STANDARD: {
    US: [], EU: [], UA: [], OTHER: [], // основний продукт (переговори) не мав юридичного ландшафту в жодному ТЗ дотепер
  },
  // Пункт [job-search] 2026-09-01: чесно порожньо — юридичний ландшафт
  // пошуку роботи (антидискримінаційні норми при наймі стосуються
  // РОБОТОДАВЦЯ, не кандидата) не досліджувався в цьому проході; той
  // самий принцип «порожньо з поясненням», що HEALTH/STANDARD.
  JOB_SEARCH: {
    US: [], EU: [], UA: [], OTHER: [],
  },
  // Пункт [health] §8 ТЗ: розділ 2 самого documenту МАЄ реальне
  // дослідження (FDA non-device CDS, HIPAA, GDPR Article 9), але
  // явно НЕ інтегроване в цей централізований словник у цьому проході
  // — чесно порожньо тут, той самий принцип, що MAJOR_PURCHASE/
  // STANDARD вище, не мовчазна прогалина без пояснення.
  HEALTH: {
    US: [], EU: [], UA: [], OTHER: [],
  },
  // Пункт [family-law] §8 ТЗ: розділ 2 самого документу МАЄ реальне
  // дослідження (UPL, mediation privilege) — явно НЕ інтегроване в
  // цей словник у цьому проході, той самий принцип, що HEALTH вище.
  // Додано ПРОАКТИВНО (не постфактум) — той самий урок, що вже раз
  // засвоєний при додаванні HEALTH до ProjectMode.
  FAMILY_LAW: {
    US: [], EU: [], UA: [], OTHER: [],
  },
  // Пункт [dtp] §8 ТЗ: розділ 2 самого документу МАЄ реальне
  // дослідження (запис третіх осіб, GDPR Ryneš), явно НЕ інтегроване
  // в цей словник у цьому проході — той самий принцип, що HEALTH/
  // FAMILY_LAW вище. Додано ПРОАКТИВНО втретє — той самий урок.
  DTP: {
    US: [], EU: [], UA: [], OTHER: [],
  },
};
