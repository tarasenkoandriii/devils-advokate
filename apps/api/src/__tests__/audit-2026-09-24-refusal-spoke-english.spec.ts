// Пункт [refusal-spoke-english] 2026-09-24 — поведенческая половина.
//
// НАЙДЕННОЕ. Два предыдущих пункта ввели и починили правило «текст
// человеку — на языке интерфейса». Оба смотрели на один канал:
// строковые литералы внутри `new …Exception(…)`.
//
// А САМЫЙ ЧАСТЫЙ ОТКАЗ API — НЕ ЛИТЕРАЛ. Глобальный `ValidationPipe`
// исполняет 179 декораторов class-validator и отдаёт свои сообщения по
// умолчанию: «rawText must be shorter than or equal to 30000
// characters». Фильтр склеивает их через «; », экран рисует как есть.
// Человек читает английскую фразу с именем поля из кода.
//
// Здесь проверяется поведение шлюза, а не наличие словаря: сообщение
// собирается из настоящих ошибок class-validator.

import { validateSync, IsString, MaxLength, MinLength, IsInt, Max, IsEnum, ValidateNested, IsArray, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { validationMessage, labelForField } from '../common/validation-message';

class Inner {
  @IsString()
  @MinLength(3)
  note!: string;
}

enum Side {
  PRO = 'PRO',
  CON = 'CON',
}

class Dto {
  @IsString()
  @MaxLength(10)
  rawText!: string;

  @IsInt()
  @Max(5)
  attempts!: number;

  @IsEnum(Side)
  stance!: Side;

  @IsArray()
  @ArrayMaxSize(2)
  questions!: string[];

  @ValidateNested()
  @Type(() => Inner)
  inner!: Inner;

  @IsString()
  someInternalKnob!: string;
}

function errorsFor(payload: Partial<Record<keyof Dto, unknown>>) {
  const dto = Object.assign(new Dto(), payload);
  return validateSync(dto, { whitelist: false });
}

describe('[refusal-spoke-english] отказ проверки говорит на языке интерфейса', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: слишком длинный текст объясняется по-русски и с числом', () => {
    const message = validationMessage(errorsFor({ rawText: 'x'.repeat(40), attempts: 1, stance: Side.PRO, questions: [], inner: Object.assign(new Inner(), { note: 'ок' }), someInternalKnob: 'k' }));

    expect(message).toContain('текст брифа — не длиннее 10 знаков');
    // Английского сообщения class-validator в ответе не остаётся.
    expect(message).not.toContain('must be shorter');
  });

  it('число из ограничения доходит до человека, а не теряется', () => {
    const message = validationMessage(errorsFor({ rawText: 'ок', attempts: 99, stance: Side.PRO, questions: [], inner: Object.assign(new Inner(), { note: 'ок' }), someInternalKnob: 'k' }));

    expect(message).toContain('не больше 5');
  });

  it('вложенное поле называется путём, а не теряется', () => {
    const message = validationMessage(errorsFor({ rawText: 'ок', attempts: 1, stance: Side.PRO, questions: [], inner: Object.assign(new Inner(), { note: 'a' }), someInternalKnob: 'k' }));

    expect(message).toContain('inner.note');
    expect(message).toContain('не короче 3 знаков');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: неизвестное поле называется КАК ЕСТЬ, а не выдуманной подписью', () => {
    // Та же честная граница, что в `field-labels.ts` у TMA: придумать
    // подпись полю, смысла которого я не проверил, — соврать увереннее,
    // чем показать имя из кода.
    expect(labelForField('someInternalKnob')).toBe('someInternalKnob');
    const message = validationMessage(errorsFor({ rawText: 'ок', attempts: 1, stance: Side.PRO, questions: [], inner: Object.assign(new Inner(), { note: 'ок' }) }));
    expect(message).toContain('someInternalKnob — должно быть текстом');
  });

  it('список и перечисление объясняются словами', () => {
    const message = validationMessage(errorsFor({ rawText: 'ок', attempts: 1, stance: 'MAYBE' as Side, questions: ['a', 'b', 'c'], inner: Object.assign(new Inner(), { note: 'ок' }), someInternalKnob: 'k' }));

    expect(message).toContain('сторона (за/против) — недопустимое значение');
    expect(message).toContain('вопросы — не больше 2 элементов');
  });

  it('несколько нарушений перечисляются, а не сводятся к первому', () => {
    const message = validationMessage(errorsFor({ rawText: 'x'.repeat(40), attempts: 99, stance: Side.PRO, questions: [], inner: Object.assign(new Inner(), { note: 'ок' }), someInternalKnob: 'k' }));

    expect(message.split(';').length).toBeGreaterThan(1);
    expect(message.startsWith('Проверьте введённое:')).toBe(true);
  });

  it('пустой список ошибок не даёт пустого сообщения', () => {
    expect(validationMessage([])).toBe('Запрос не прошёл проверку');
  });
});
