// Пункт [failure-spoke-to-the-operator] 2026-09-25 — текст сбоя,
// написанный для оператора, читал человек.
//
// Причина провала асинхронной задачи пишется в `AIJob.partialResult`,
// оттуда её забирают обработчики завершения и кладут в поля, которые
// РИСУЕТ ЭКРАН: `paralinguisticsError`, `autoAnalysisError`,
// `matchNotes`. А написаны эти причины были для оператора — с «lease»,
// «pg_cron», «max_output_tokens» и сырым телом ответа провайдера.
//
// У синхронного пути общий шлюз есть с сентября
// (`common/ai-error-passthrough.ts`, Пункт [ai-errors]); у асинхронной
// полосы такого шлюза не было — правило было, просто не везде.

import { failureText, unknownFailureText, PERSON_TEXTS, type FailureKind } from '../ai-router/failure-reason';
import { mediaFailureText } from '../media-review/media-review-auto.service';

/** Слова, которых человеку показывать нельзя: они называют наше
 * устройство, а не его положение. */
const MACHINE_WORDS = [
  'lease',
  'pg_cron',
  'max_output_tokens',
  'budget_exceeded',
  'requires_action',
  'incomplete',
  'EXTERNAL_INTERACTION',
  'HTTP ',
  'воркер',
  'схем',
];

describe('[failure-spoke-to-the-operator] у провала два адресата и два текста', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни в одном человеческом тексте нет внутренних слов', () => {
    const offenders: string[] = [];
    for (const [kind, text] of Object.entries(PERSON_TEXTS)) {
      for (const word of MACHINE_WORDS) {
        if (text.toLowerCase().includes(word.toLowerCase())) offenders.push(`${kind}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: тот же отбор находит внутреннее слово, когда оно есть', () => {
    // Иначе пустой список выше проходил бы и при пустом списке слов.
    const probe = (text: string) => MACHINE_WORDS.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
    expect(probe('ответ упёрся в max_output_tokens')).toContain('max_output_tokens');
    expect(probe(PERSON_TEXTS['provider-incomplete'])).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: операторская подробность НЕ равна человеческой и не теряется', () => {
    const pair = failureText('provider-rejected', 'запрос отвергнут (HTTP 400): {"error":"Unknown name system_instruction"}');
    expect(pair.person).not.toContain('system_instruction');
    expect(pair.person).not.toContain('400');
    // Подробность не выброшена — она уходит в лог рядом с задачей.
    expect(pair.operator).toContain('system_instruction');
    expect(pair.operator).toContain('provider-rejected');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человеку сказано, ЧТО ДЕЛАТЬ или что дело не в нём', () => {
    // «Не получилось» без продолжения человек читает как свою вину и
    // как тупик. У каждого текста обязан быть выход: повторить, взять
    // другой материал, подождать — либо прямое «это наша сторона».
    for (const [kind, text] of Object.entries(PERSON_TEXTS)) {
      const hasWayOut = /попробуйте|попробовать|ещё раз|завтра|фрагмент|это наша сторона|не отправлялось/i.test(text);
      expect(`${kind}: ${hasWayOut}`).toBe(`${kind}: true`);
      expect(text.length).toBeGreaterThan(40);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: подсказка про ролик привязана к ВИДУ провала, а не к подстроке в тексте', () => {
    // Раньше обработчик узнавал вид по словам «валидацию схемы» в
    // человеческом тексте: правка текста молча выключала бы подсказку.
    const base = PERSON_TEXTS['schema-invalid'];
    expect(mediaFailureText(base, 'schema-invalid')).toContain('липсинк');
    expect(mediaFailureText(base, 'provider-timeout')).toBe(base);
    // И подсказка не появляется от одного лишь совпадения слов.
    expect(mediaFailureText('что-то про схему и валидацию', undefined)).not.toContain('липсинк');
  });

  it('незнакомый провал честно называется незнакомым, а не объясняется наугад', () => {
    const pair = unknownFailureText('что-то странное');
    expect(pair.person).toContain('причину мы назвать не можем');
    expect(pair.operator).toContain('что-то странное');
  });

  it('вид провала — значение из перечисления, а не свободная строка', () => {
    // Иначе обработчик снова начнёт узнавать вид по подстроке в тексте.
    const kinds: FailureKind[] = Object.keys(PERSON_TEXTS) as FailureKind[];
    expect(kinds.length).toBeGreaterThanOrEqual(10);
    for (const k of kinds) expect(failureText(k, 'x').person).toBe(PERSON_TEXTS[k]);
  });
});
