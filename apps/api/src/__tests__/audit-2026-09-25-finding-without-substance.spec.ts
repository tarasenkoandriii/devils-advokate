// Пункты [finding-without-substance] 2026-09-25 и
// [finding-without-substance-2] 2026-09-26 — проверка на ПОВЕДЕНИИ, а не
// на упоминании.
//
// Спека вызывает НАСТОЯЩИЕ валидаторы двадцати сервисов и настоящие
// правила поэлементного отбрасывания, а не ищет в их тексте слово
// `allFilled`. Разница уже стоила проекту одного пункта
// ([probe-checked-the-neighbour]): проверка, написанная на упоминание,
// остаётся зелёной, когда вызов подменили на соседнее выражение.
//
// ЧТО ИЗМЕНИЛ ВТОРОЙ ПРОХОД, И ЭТО ПОПРАВКА К ПЕРВОМУ. У ответа модели
// есть ТРИ разных ответа на «что если поле пусто», и путать их нельзя:
//
//   required — валидация ответа не пройдена, запрос повторяется. Так
//     можно только там, где у места НЕТ поэлементного отбрасывания;
//   dropped  — отбрасывается ОДИН элемент, со счётчиком. Там, где такое
//     отбрасывание уже есть (`keepQuoted`, `sanitizePositionDraft`),
//     требование существа обязано стоять в том же месте: завалить весь
//     ответ значило бы потерять соседние настоящие находки И число, по
//     которому экран отличает «не найдено» от «не смогли подтвердить»;
//   optional — пустота законна, и в реестре записано, почему.
//
// Первый проход этого различения не делал, потому что у всех восьми его
// мест поэлементного отбрасывания по существу не было. Второй наткнулся
// на три места, где оно есть, — и наткнулся не рассуждением, а двумя
// покрасневшими чужими проверками.
//
// Файл намеренно не читает исходники (`readFileSync`), поэтому потолок
// сканирующих проверок он не трогает. Замкнутость населения — вопрос
// другой, и она проверяется отдельной спекой
// (`audit-2026-09-26-substance-population.spec.ts`).

import {
  CLAIM_SUBSTANCE,
  substanceSite,
  filled,
  allFilled,
  allStringsFilled,
  type SubstanceSite,
} from '../common/claim-substance';
import { isValidManipulationPayload } from '../manipulation-detector/manipulation-detector.service';
import { isValidFlagsPayload } from '../live-manipulation/live-manipulation.service';
import { isValidTurningPointsPayload } from '../turning-points/turning-points.service';
import { isValidDoNotSayPayload } from '../do-not-say/do-not-say.service';
import { isValidMotivePayload } from '../motive-analysis/motive-analysis.service';
import { isValidConflictsPayload } from '../source-conflict/source-conflict.service';
import { isValidRecommendationPayload } from '../best-next-move/best-next-move.service';
import { isValidAnalysisPayload } from '../prediction/prediction.service';
import { isValidGeneratedPayload } from '../arguments/argument-generation.service';
import {
  isValidTargetedArgumentsPayload,
  isValidSuggestRolesPayload,
} from '../stakeholder-map/stakeholder-map.service';
import { isValidAgendaPayload } from '../conversation-agenda/conversation-agenda.service';
import { isValidQuestionsPayload } from '../missing-information/missing-information.service';
import { isValidBreakdown as isValidDtpBreakdown } from '../dtp/dtp.service';
import { isValidBreakdown as isValidHealthBreakdown } from '../health/health.service';
import { isValidBreakdown as isValidFamilyLawBreakdown } from '../family-law/family-law.service';
import { isValidBreakdown as isValidInvestmentBreakdown } from '../investment/investment.service';
import {
  isValidQuestions,
  isValidFlags,
  complianceFlagWorthShowing,
} from '../client-brief/client-brief.service';
import {
  isValidDiscrepancies,
  isValidFacts,
  discrepancyWorthShowing,
} from '../employer-dossier/employer-dossier.service';
import { isValidAssessment } from '../interview-pool/interview-pool-relevance.service';
import { isValidReligionSuggestionPayload } from '../onboarding/onboarding.service';
import { isValidPositionsPayload, sanitizePositionDraft } from '../terms-sheet/terms-matching.service';
import { TermsClauseKind } from '@prisma/client';

type Validator = (text: string) => boolean;
type Item = Record<string, unknown>;

/** Образец ответа модели, который ДОЛЖЕН проходить валидацию целиком.
 * Всё, что спека утверждает про отказ, измеряется от него: если образец
 * сам по себе невалиден, отказ ничего не доказывает. */
interface Fixture {
  validator: Validator;
  /** Ответ модели ЦЕЛИКОМ, в той форме, в какой его просит промпт. */
  sample: unknown;
  /** Где лежит основной элемент: '' — сам объект, '[]' — массив строк,
   * иначе имя массива объектов внутри ответа. */
  primary: string;
  /** Правило поэлементного отбрасывания — для полей из `dropped`.
   * Принимает ЭЛЕМЕНТ и отвечает, стоит ли его показывать. */
  drop?: (item: Item) => boolean;
  /** Законен ли пустой список как способ сказать «ничего не нашлось». */
  emptyIsLegal?: boolean;
}

const BRIEF = 'Нужен продажник, без маленьких детей, офис в Киеве';
const FACTS = 'зареєстровано у Львові';
const DOCUMENT = 'офис в Киеве';

const FIXTURES: Record<string, Fixture> = {
  // ── первый проход ───────────────────────────────────────────────
  isValidManipulationPayload: {
    validator: isValidManipulationPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ segmentId: 'seg-1', technique: 'подмена темы', description: 'ушёл от вопроса о сроках', confidence: 0.6 }],
  },
  isValidFlagsPayload: {
    validator: isValidFlagsPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ technique: 'давление срочностью', description: 'требует ответа сейчас', confidence: 0.5 }],
  },
  isValidTurningPointsPayload: {
    validator: isValidTurningPointsPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ segmentId: 'seg-2', signalType: 'EMOTIONAL_SHIFT', description: 'тон сменился после вопроса о деньгах', confidence: 0.7 }],
  },
  isValidDoNotSayPayload: {
    validator: isValidDoNotSayPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ segmentId: 'seg-3', riskCategory: 'ESCALATION', why: 'звучит как обвинение', saferAlternative: 'я заметил, что сроки сдвинулись' }],
  },
  isValidMotivePayload: {
    validator: isValidMotivePayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{
      explanation: 'возможное объяснение — он защищает свой участок работы',
      supportingFactsSummary: 'дважды просил не выносить вопрос на общую встречу',
      confidence: 'MEDIUM',
    }],
  },
  isValidConflictsPayload: {
    validator: isValidConflictsPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{
      factAId: 'fact-a',
      factBId: 'fact-b',
      conflictDescription: 'в одном месте сказано «в марте», в другом «в мае»',
      possibleExplanations: ['мог перепутать месяц'],
      clarifyingQuestion: 'уточните, когда именно это было?',
    }],
  },
  isValidRecommendationPayload: {
    validator: isValidRecommendationPayload,
    primary: '',
    sample: {
      bestAction: 'написать письмо с фиксацией договорённостей',
      alternative: 'дождаться следующей встречи',
      avoid: 'обсуждать это в общем чате',
      why: 'письменная фиксация снимает спор о том, что было сказано',
    },
  },
  isValidAnalysisPayload: {
    validator: isValidAnalysisPayload,
    primary: '',
    sample: { difference: 'срок сдвинулся на месяц, а не на неделю', lesson: 'оценку сроков давал тот, кто не работает с подрядчиком' },
  },

  // ── второй проход ───────────────────────────────────────────────
  isValidGeneratedPayload: {
    validator: isValidGeneratedPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ text: 'срок можно сдвинуть, не меняя цену', stance: 'pro', weight: 0.6 }],
  },
  isValidTargetedArgumentsPayload: {
    validator: isValidTargetedArgumentsPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: [{ text: 'для него важнее предсказуемость, чем скорость', stance: 'pro', weight: 0.5 }],
  },
  isValidAgendaPayload: {
    validator: isValidAgendaPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: ['вернуться к срокам, о которых договорились в марте'],
  },
  isValidQuestionsPayload: {
    validator: isValidQuestionsPayload,
    primary: '[]',
    emptyIsLegal: true,
    sample: ['кто реально принимает решение?'],
  },
  isValidBreakdown: {
    validator: isValidDtpBreakdown,
    primary: 'criteriaBreakdown',
    sample: { criteriaBreakdown: [{ criterionId: 'crit-1', whatWasSaid: 'сказал, что осмотр был через два дня', sourceSegmentId: '3' }] },
  },
  isValidQuestions: {
    validator: isValidQuestions,
    primary: 'questions',
    sample: { questions: [{ topic: 'зарплата', question: 'какая вилка по этой роли?', quote: 'зарплата обсуждается' }] },
  },
  isValidFlags: {
    validator: isValidFlags,
    primary: 'flags',
    drop: (item) => complianceFlagWorthShowing(item as never, BRIEF),
    sample: { flags: [{ category: 'семейное положение', quotedText: 'без маленьких детей', alternativeText: 'готовность к командировкам 2 раза в месяц' }] },
  },
  isValidFacts: {
    validator: isValidFacts,
    primary: 'facts',
    sample: { facts: [{ category: 'REGISTRY', quote: FACTS }] },
  },
  isValidDiscrepancies: {
    validator: isValidDiscrepancies,
    primary: 'discrepancies',
    drop: (item) => discrepancyWorthShowing(item as never, FACTS, DOCUMENT),
    sample: { discrepancies: [{ topic: 'адрес', factQuote: FACTS, documentQuote: DOCUMENT, note: 'в реестре Львов, в брифе Киев' }] },
  },
  isValidAssessment: {
    validator: isValidAssessment,
    primary: 'criteriaBreakdown',
    sample: {
      criteriaBreakdown: [{ questionnaireItemId: 'q-1', coverage: 'partial', note: 'сказал общими словами, без примера', sourceSegmentId: '2' }],
      attentionPoints: ['опыт руководства требует проверки'],
      followUpRequests: ['пример работы по этому проекту'],
    },
  },
  isValidReligionSuggestionPayload: {
    validator: isValidReligionSuggestionPayload,
    primary: '',
    sample: { suggestedReligion: 'католицизм', reasoning: 'по стране это самая распространённая конфессия, но состав неоднороден' },
  },
  isValidSuggestRolesPayload: {
    validator: isValidSuggestRolesPayload,
    primary: 'roleSuggestions',
    sample: {
      roleSuggestions: [{ personId: 'p-1', role: 'DECISION_MAKER', reasoning: 'подписывает бюджет по этому направлению' }],
      gapSuggestions: [{ roleHint: 'юрист со стороны заказчика', reasoning: 'условия расторжения никто не смотрел' }],
    },
  },
  isValidPositionsPayload: {
    validator: isValidPositionsPayload,
    primary: 'positions',
    drop: (item) => {
      const out = sanitizePositionDraft(item as never, { id: 'c', kind: TermsClauseKind.REQUIREMENT }, { sourceText: 'в тексте есть эта цитата' });
      return !('rejected' in out);
    },
    sample: {
      positions: [{ clauseId: 'c', coverage: 'covered', stance: null, note: 'требование закрыто опытом на прошлом месте', evidenceRef: null, evidenceQuote: 'эта цитата' }],
    },
  },
};

/** Подмена ОДНОГО поля в образце. Формы пути — те же четыре, что в
 * реестре: `поле`, `[]` (сам элемент-строка), `массив[]` (строка внутри
 * массива верхнего уровня), `массив[].поле`. */
function withField(sample: unknown, primary: string, field: string, value: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(sample));
  if (field === '[]') return [value];
  const nested = /^(\w+)\[\]\.(\w+)$/.exec(field);
  if (nested) {
    clone[nested[1]] = [{ ...clone[nested[1]][0], [nested[2]]: value }];
    return clone;
  }
  const stringArray = /^(\w+)\[\]$/.exec(field);
  if (stringArray) {
    // Массив строк бывает и у ответа целиком (`attentionPoints`), и
    // внутри элемента (`possibleExplanations`). Куда положить, решает сам
    // образец: если такой ключ есть у ответа — значит он там и живёт.
    const name = stringArray[1];
    if (!Array.isArray(clone) && name in clone) {
      clone[name] = [value];
      return clone;
    }
    if (primary === '[]') {
      clone[0] = { ...clone[0], [name]: [value] };
      return clone;
    }
    if (primary === '') {
      clone[name] = [value];
      return clone;
    }
    clone[primary] = [{ ...clone[primary][0], [name]: [value] }];
    return clone;
  }
  if (primary === '') {
    clone[field] = value;
    return clone;
  }
  if (primary === '[]') {
    clone[0] = { ...clone[0], [field]: value };
    return clone;
  }
  clone[primary] = [{ ...clone[primary][0], [field]: value }];
  return clone;
}

/** Один ЭЛЕМЕНТ образца с подменённым полем — для правил поэлементного
 * отбрасывания, которые видят элемент, а не весь ответ. */
function itemWith(fx: Fixture, field: string, value: unknown): Item {
  const payload = withField(fx.sample, fx.primary, field, value) as Record<string, unknown>;
  const list = fx.primary === '[]' ? (payload as unknown as Item[]) : (payload[fx.primary] as Item[]);
  return list[0];
}

function payloadWith(site: SubstanceSite, field: string, value: unknown): string {
  const fx = FIXTURES[site.key];
  return JSON.stringify(withField(fx.sample, fx.primary, field, value));
}

function accepts(site: SubstanceSite, field: string, value: unknown): boolean {
  return FIXTURES[site.key].validator(payloadWith(site, field, value));
}

const EMPTIES = ['', '   \n\t '];

describe('Пункты [finding-without-substance] 2026-09-25 / -2 2026-09-26: находка без содержания', () => {
  it('реестр покрывает ровно те места, для которых спека держит образец', () => {
    expect(CLAIM_SUBSTANCE.map((s) => s.key).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it('образец каждого места проходит валидацию целиком — иначе отказ ничего не доказывает', () => {
    for (const site of CLAIM_SUBSTANCE) {
      const fx = FIXTURES[site.key];
      expect(`${site.key}: ${fx.validator(JSON.stringify(fx.sample))}`).toBe(`${site.key}: true`);
      // И образец элемента проходит правило отбрасывания там, где оно
      // есть: иначе проверка отказа ниже ничего не значит.
      if (fx.drop) expect(`${site.key}: ${fx.drop(itemWith(fx, '__нет-такого', 1))}`).toBe(`${site.key}: true`);
    }
  });

  it('`filled` считает содержанием только непробельный текст', () => {
    for (const empty of ['', ' ', '\t', '\n  \n', ' '.replace(' ', ' ')]) {
      expect(filled(empty)).toBe(false);
    }
    for (const notText of [null, undefined, 0, 1, false, true, [], {}, ['x']]) {
      expect(filled(notText)).toBe(false);
    }
    expect(filled('есть что прочитать')).toBe(true);
    expect(filled(' и по краям пробелы ')).toBe(true);
  });

  it('`allFilled` не принимает не-объект за объект с полями', () => {
    expect(allFilled(null, ['a'])).toBe(false);
    expect(allFilled('строка', ['a'])).toBe(false);
    expect(allFilled(42, ['a'])).toBe(false);
    expect(allFilled({ a: 'есть' }, ['a'])).toBe(true);
    expect(allFilled({ a: 'есть' }, ['a', 'b'])).toBe(false);
  });

  it('`allStringsFilled`: пустой список законен, пустая строка внутри — нет', () => {
    // Разница ровно та, что записана у `possibleExplanations[]`: списка
    // может не быть вовсе, а вот элемента без текста в нём быть не может.
    expect(allStringsFilled([])).toBe(true);
    expect(allStringsFilled(['есть вопрос'])).toBe(true);
    expect(allStringsFilled(['есть вопрос', ''])).toBe(false);
    expect(allStringsFilled([' \t '])).toBe(false);
    expect(allStringsFilled(['есть', 42])).toBe(false);
    expect(allStringsFilled('не массив')).toBe(false);
    expect(allStringsFilled(null)).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одно обязательное поле находки не принимается пустым', () => {
    let checked = 0;
    for (const site of CLAIM_SUBSTANCE) {
      for (const { field } of site.required) {
        for (const empty of EMPTIES) {
          expect(`${site.key}.${field}: ${accepts(site, field, empty)}`).toBe(`${site.key}.${field}: false`);
        }
        checked++;
      }
    }
    // Число фиксируется: молчаливо опустевший реестр прошёл бы цикл
    // насквозь, ничего не проверив, и остался бы зелёным.
    expect(checked).toBe(32);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: поле, отбрасывающее ОДИН элемент, отбрасывает именно его — а ответ остаётся годным', () => {
    // Поправка второго прохода целиком: пустое поле здесь обязано
    // убрать ОДНУ находку со счётчиком и НЕ завалить весь ответ.
    let checked = 0;
    for (const site of CLAIM_SUBSTANCE) {
      if (site.dropped.length === 0) continue;
      const fx = FIXTURES[site.key];
      for (const { field } of site.dropped) {
        for (const empty of EMPTIES) {
          expect(`${site.key}.${field} отброшен: ${fx.drop!(itemWith(fx, field, empty))}`).toBe(`${site.key}.${field} отброшен: false`);
        }
        // А валидатор ответа его пропускает — иначе соседние настоящие
        // находки и само число потерялись бы вместе с ним.
        expect(`${site.key}.${field} ответ годен: ${accepts(site, field, '')}`).toBe(`${site.key}.${field} ответ годен: true`);
        checked++;
      }
    }
    expect(checked).toBe(5);
  });

  it('обратная проба: то же поле с текстом — принимается', () => {
    for (const site of CLAIM_SUBSTANCE) {
      for (const { field } of site.required) {
        expect(`${site.key}.${field}: ${accepts(site, field, 'непустое содержание находки')}`).toBe(`${site.key}.${field}: true`);
      }
      const fx = FIXTURES[site.key];
      for (const { field } of site.dropped) {
        expect(`${site.key}.${field}: ${fx.drop!(itemWith(fx, field, 'непустое содержание находки'))}`).toBe(`${site.key}.${field}: true`);
      }
    }
  });

  it('обратная проба: поля, которым пустота разрешена, ответ не заваливают', () => {
    let checked = 0;
    for (const site of CLAIM_SUBSTANCE) {
      for (const { field } of site.optional) {
        // Пустой идентификатор обнаруживается ниже по потоку — находка
        // отбрасывается со счётчиком; заваливать из-за него ВЕСЬ батч
        // значило бы потерять соседние настоящие находки.
        expect(`${site.key}.${field}: ${accepts(site, field, '')}`).toBe(`${site.key}.${field}: true`);
        checked++;
      }
    }
    expect(checked).toBe(23);
  });

  it('у каждого поля реестра записан довод, а не отметка', () => {
    for (const site of CLAIM_SUBSTANCE) {
      expect(site.required.length + site.dropped.length + site.optional.length).toBeGreaterThan(0);
      for (const f of [...site.required, ...site.dropped, ...site.optional]) {
        expect(`${site.key}.${f.field}: ${f.why.length > 25}`).toBe(`${site.key}.${f.field}: true`);
        expect(f.field.length).toBeGreaterThan(0);
      }
      expect(site.record.length).toBeGreaterThan(20);
      expect(site.where.length).toBeGreaterThan(10);
    }
  });

  it('`substanceSite` не выдумывает место, которого в реестре нет', () => {
    expect(substanceSite('isValidAnalysisPayload').required.map((f) => f.field)).toEqual(['difference', 'lesson']);
    expect(() => substanceSite('isValidНетТакого')).toThrow(/Неизвестное место/);
  });

  it('пустой список находок остаётся законным ответом — способ сказать «не нашлось» не сломан', () => {
    let checked = 0;
    for (const site of CLAIM_SUBSTANCE) {
      if (!FIXTURES[site.key].emptyIsLegal) continue;
      expect(`${site.key}: ${FIXTURES[site.key].validator('[]')}`).toBe(`${site.key}: true`);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: четыре копии одного валидатора ведут себя одинаково', () => {
    // dtp, health, family-law, investment держат ЧЕТЫРЕ идентичные копии
    // `isValidBreakdown`. Реестр знает одну запись; поправить три копии
    // и забыть четвёртую — ровно тот способ разъехаться, который в этом
    // проекте уже стоил нескольких пунктов.
    const copies = [isValidDtpBreakdown, isValidHealthBreakdown, isValidFamilyLawBreakdown, isValidInvestmentBreakdown];
    const good = JSON.stringify(FIXTURES.isValidBreakdown.sample);
    const empty = payloadWith(substanceSite('isValidBreakdown'), 'whatWasSaid', '');
    expect(copies.map((v) => v(good))).toEqual([true, true, true, true]);
    expect(copies.map((v) => v(empty))).toEqual([false, false, false, false]);
  });
});
