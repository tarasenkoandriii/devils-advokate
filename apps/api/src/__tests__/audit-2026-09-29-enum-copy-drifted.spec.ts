// Пункт [enum-copy-drifted] 2026-09-29 — поведенческая половина.
//
// Утверждение пункта — не «в коде больше нет литералов», а «сверка
// принимает КАЖДОЕ значение своего перечисления». Разница видна на
// единственном случае, ради которого пункт и написан: в перечисление
// добавили значение. Проверка на текст исходника этого не заметит —
// список-то заменён, — а проверка на поведении покраснеет ровно тогда,
// когда новое значение перестанет проходить.
//
// Поэтому здесь для каждой сверки перебираются ВСЕ значения
// перечисления, взятые из `@prisma/client`, а не переписанные тут же
// рядом: иначе спека завела бы третью копию того же списка и проверяла
// бы копию против копии.
//
// Файл намеренно не читает исходники: замкнутость населения — вопрос
// другой, и её проверяет `audit-2026-09-29-enum-population.spec.ts`.

import {
  AIJobStatus,
  ArgumentStance,
  ArgumentTrackingState,
  ClauseCoverage,
  ConversationSignalType,
  JobVacancyLocationMatch,
  LiveHintType,
  MediaReviewItemStatus,
  MotiveConfidenceLevel,
  PrecedentSimilarity,
  ScenarioConfidence,
  ScenarioType,
  SelfRiskCategory,
  SignalSeverity,
  StakeholderRole,
  WeatherRecommendation,
} from '@prisma/client';

import { enumValues, isEnumValue, subsetOf } from '../common/enum-values';
import { isValidDoNotSayPayload } from '../do-not-say/do-not-say.service';
import { isValidMotivePayload } from '../motive-analysis/motive-analysis.service';
import { isValidTurningPointsPayload } from '../turning-points/turning-points.service';
import { isValidSuggestRolesPayload } from '../stakeholder-map/stakeholder-map.service';
import { isValidDiscrepancyPayload, isValidSourceCheckPayload } from '../discrepancy-analysis/discrepancy-analysis.service';
import { isValidMatch } from '../job-search/job-search.service';
import { isValidTrackingPayload } from '../live-argument-tracking/live-argument-tracking.service';
import { isValidScenarioPayload } from '../outcome-forecasting/outcome-forecasting.service';
import { isValidPrecedentPayload } from '../precedent-search/precedent-search.service';
import { isValidRecommendationPayload } from '../weather-forecast/weather-forecast.service';
import { isValidHintPayload } from '../live-hints/live-hints.service';
import { isValidAssessment } from '../interview-pool/interview-pool-relevance.service';

type Validator = (text: string) => boolean;

/** Место, где ответ модели проверяется на принадлежность перечислению. */
interface EnumCheck {
  /** Имя для сообщения об ошибке — чтобы не искать, какая из строк упала. */
  name: string;
  validator: Validator;
  /** Перечисление Prisma, которое здесь и есть источник правды. */
  enumObject: Record<string, string>;
  /** Собрать ответ модели с этим значением в проверяемом поле. */
  payload(value: string): unknown;
  /** Значения, которые место принимает НАМЕРЕННО не все, и почему. */
  accepts?: readonly string[];
}

const CHECKS: EnumCheck[] = [
  {
    name: 'do-not-say: riskCategory',
    validator: isValidDoNotSayPayload,
    enumObject: SelfRiskCategory,
    payload: (v) => [{ segmentId: 's1', riskCategory: v, why: 'звучит как обвинение', saferAlternative: 'сроки сдвинулись' }],
  },
  {
    name: 'motive-analysis: confidence',
    validator: isValidMotivePayload,
    enumObject: MotiveConfidenceLevel,
    payload: (v) => [{ explanation: 'защищает свой участок', supportingFactsSummary: 'дважды просил не выносить', confidence: v }],
  },
  {
    name: 'turning-points: signalType (подмножество)',
    validator: isValidTurningPointsPayload,
    enumObject: ConversationSignalType,
    accepts: [ConversationSignalType.EMOTIONAL_SHIFT, ConversationSignalType.ARGUMENT_ACCEPTANCE],
    payload: (v) => [{ segmentId: 's1', signalType: v, description: 'тон сменился' }],
  },
  {
    name: 'stakeholder-map: role',
    validator: isValidSuggestRolesPayload,
    enumObject: StakeholderRole,
    payload: (v) => ({
      roleSuggestions: [{ personId: 'p1', role: v, reasoning: 'подписывает бюджет' }],
      gapSuggestions: [{ roleHint: 'юрист', reasoning: 'условия не смотрели' }],
    }),
  },
  {
    name: 'discrepancy-analysis: severity (список расхождений)',
    validator: isValidDiscrepancyPayload,
    enumObject: SignalSeverity,
    payload: (v) => [{ segmentId: 's1', severity: v, sourceDescription: 'договор от 3 марта', potentialImpact: 'сроки сдвинутся' }],
  },
  {
    name: 'discrepancy-analysis: severity (сверка с источником)',
    validator: isValidSourceCheckPayload,
    enumObject: SignalSeverity,
    // `severity` спрашивается только у опровергнутого утверждения — у
    // остальных исходов его нет вовсе (§3.16), и перебирать перечисление
    // имеет смысл ровно в этой ветке.
    payload: (v) => ({ outcome: 'CONTRADICTED', severity: v, explanation: 'источник говорит иначе', potentialImpact: 'вывод придётся поправить' }),
  },
  {
    name: 'job-search: locationMatch',
    validator: isValidMatch,
    enumObject: JobVacancyLocationMatch,
    payload: (v) => ({
      title: 'Менеджер',
      locationMatch: v,
      salaryMentioned: null,
      matchBreakdown: [{ criterionId: 'c1', coverage: ClauseCoverage.covered, note: 'сказано прямо' }],
      notes: 'заметки',
    }),
  },
  {
    name: 'job-search: coverage',
    validator: isValidMatch,
    enumObject: ClauseCoverage,
    payload: (v) => ({
      title: 'Менеджер',
      locationMatch: JobVacancyLocationMatch.MATCHES,
      salaryMentioned: null,
      matchBreakdown: [{ criterionId: 'c1', coverage: v, note: 'сказано прямо' }],
      notes: 'заметки',
    }),
  },
  {
    name: 'live-argument-tracking: status',
    validator: isValidTrackingPayload,
    enumObject: ArgumentTrackingState,
    payload: (v) => [{ argumentId: 'a1', status: v }],
  },
  {
    name: 'outcome-forecasting: scenarioType',
    validator: isValidScenarioPayload,
    enumObject: ScenarioType,
    payload: (v) => [{ scenarioType: v, outcomeDescription: 'срок сдвинется', confidence: ScenarioConfidence.MEDIUM, userDescription: 'свой вариант' }],
  },
  {
    name: 'outcome-forecasting: confidence',
    validator: isValidScenarioPayload,
    enumObject: ScenarioConfidence,
    payload: (v) => [{ scenarioType: ScenarioType.DO_NOTHING, outcomeDescription: 'срок сдвинется', confidence: v }],
  },
  {
    name: 'precedent-search: similarity',
    validator: isValidPrecedentPayload,
    enumObject: PrecedentSimilarity,
    payload: (v) => [{ precedentDescription: 'похожий случай', sourceDescription: 'разбор дела', similarity: v }],
  },
  {
    name: 'weather-forecast: recommendation',
    validator: isValidRecommendationPayload,
    enumObject: WeatherRecommendation,
    payload: (v) => ({ recommendation: v, reason: 'дождь весь день' }),
  },
  {
    name: 'live-hints: hintType (подмножество)',
    validator: isValidHintPayload,
    enumObject: LiveHintType,
    accepts: [LiveHintType.ARGUMENT_SUGGESTION, LiveHintType.TOPIC_REPETITION],
    payload: (v) => ({ hintType: v, hintText: 'сейчас уместно сказать про сроки', suggestedArgumentIndex: 0 }),
  },
  {
    name: 'interview-pool: coverage (подмножество)',
    validator: isValidAssessment,
    enumObject: ClauseCoverage,
    accepts: [ClauseCoverage.covered, ClauseCoverage.partial, ClauseCoverage.not_covered],
    payload: (v) => ({
      criteriaBreakdown: [{ questionnaireItemId: 'q1', coverage: v, note: 'сказал общими словами', sourceSegmentId: '2' }],
      attentionPoints: ['нужна проверка'],
      followUpRequests: ['пример работы'],
    }),
  },
];

/** Значение, которого в перечислении заведомо нет. Строится из него
 * самого — выдуманная константа однажды совпала бы с новым значением. */
function strayValue(e: Record<string, string>): string {
  const all = Object.values(e);
  let candidate = `${all[0]}_НЕТ_ТАКОГО`;
  while (all.includes(candidate)) candidate += 'X';
  return candidate;
}

describe('Пункт [enum-copy-drifted] 2026-09-29: сверка принимает каждое значение своего перечисления', () => {
  it('проба механизма: перечисления пришли из клиента Prisma и непусты', () => {
    // Если бы перечисления импортировались пустыми, все циклы ниже
    // прошли бы насквозь, ничего не проверив, и остались бы зелёными.
    expect(CHECKS.length).toBe(15);
    for (const c of CHECKS) {
      expect(`${c.name}: ${Object.values(c.enumObject).length > 1}`).toBe(`${c.name}: true`);
    }
    // Точные числа у тех перечислений, вокруг которых весь пункт.
    expect(enumValues(ConversationSignalType).length).toBe(7);
    expect(enumValues(ClauseCoverage).length).toBe(4);
    expect(enumValues(AIJobStatus).length).toBe(6);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждое значение перечисления сверка ПРИНИМАЕТ', () => {
    // Ради этого теста пункт и написан. Перечисление вырастет — а список
    // в сверке останется прежним, — и новое значение не пройдёт
    // валидацию: фича не заработает ни разу, а человек прочитает
    // «модель вернула ответ, который не удалось разобрать».
    let checked = 0;
    for (const c of CHECKS) {
      const allowed = c.accepts ?? Object.values(c.enumObject);
      for (const value of allowed) {
        expect(`${c.name}=${value}: ${c.validator(JSON.stringify(c.payload(value)))}`).toBe(`${c.name}=${value}: true`);
        checked++;
      }
    }
    expect(checked).toBe(45);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: значение ВНЕ перечисления сверка отвергает', () => {
    // Обратная сторона: без неё предыдущий тест проходил бы и в мире,
    // где сверка принимает что угодно, — то есть где приведение `as`
    // отправляет в базу значение, которого в перечислении нет.
    for (const c of CHECKS) {
      const stray = strayValue(c.enumObject);
      expect(`${c.name}=${stray}: ${c.validator(JSON.stringify(c.payload(stray)))}`).toBe(`${c.name}=${stray}: false`);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сужение отвергает ОСТАЛЬНЫЕ значения перечисления, а не всё подряд', () => {
    // У сужений проверяется именно граница: значения, которые место
    // намеренно не принимает, существуют в перечислении и должны быть
    // отвергнуты. Иначе «подмножество» ничем не отличалось бы от
    // «принимаем всё».
    let checked = 0;
    for (const c of CHECKS) {
      if (!c.accepts) continue;
      const rest = Object.values(c.enumObject).filter((v) => !c.accepts!.includes(v));
      expect(`${c.name}: остаток непуст = ${rest.length > 0}`).toBe(`${c.name}: остаток непуст = true`);
      for (const value of rest) {
        expect(`${c.name}=${value}: ${c.validator(JSON.stringify(c.payload(value)))}`).toBe(`${c.name}=${value}: false`);
        checked++;
      }
    }
    expect(checked).toBe(7);
  });

  it('`isEnumValue` сужает тип и не верит строке на слово', () => {
    expect(isEnumValue(SignalSeverity, 'INACCURACY')).toBe(true);
    expect(isEnumValue(SignalSeverity, 'inaccuracy')).toBe(false);
    expect(isEnumValue(SignalSeverity, '')).toBe(false);
    expect(isEnumValue(SignalSeverity, null)).toBe(false);
    expect(isEnumValue(SignalSeverity, 0)).toBe(false);
    expect(isEnumValue(SignalSeverity, ['INACCURACY'])).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: `subsetOf` не принимает то, чего в перечислении нет', () => {
    // Приведение `as` эту ошибку пропускает молча; проверка на запуске —
    // единственное, что её поймает, если значение уберут из схемы.
    expect(() =>
      subsetOf(MediaReviewItemStatus, ['НЕТ_ТАКОГО'] as never, 'проба'),
    ).toThrow(/которых в нём нет/);
    // И «подмножество» размером со всё перечисление — не подмножество:
    // оно молча переставало бы следить за ростом перечисления.
    expect(() =>
      subsetOf(WeatherRecommendation, enumValues(WeatherRecommendation) as never, 'проба'),
    ).toThrow(/для ЧАСТИ перечисления/);
    expect(() => subsetOf(ArgumentStance, [] as never, 'проба')).toThrow(/для ЧАСТИ перечисления/);
    // Обратная проба: настоящее подмножество проходит и отдаёт ровно то,
    // что выбрали.
    expect(subsetOf(ArgumentStance, [ArgumentStance.PRO, ArgumentStance.CON], 'только за и против')).toEqual(['PRO', 'CON']);
  });
});
