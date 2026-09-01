// Пункт [validation] 2026-09-01 — глобальная валидация (из отчёта
// аудита «ValidationPipe не используется нигде»): защита от инъекции
// Prisma-операторов через query + лимиты на высокорисковых DTO.

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { StringQueryGuardPipe } from '../common/string-query-guard.pipe';
import { SynthesizeDto } from '../text-to-speech/text-to-speech.controller';
import { TextDto } from '../intake/intake.controller';

describe('StringQueryGuardPipe', () => {
  const pipe = new StringQueryGuardPipe();

  it('КЛЮЧЕВОЙ ТЕСТ: ?category[not]=x (объект вместо строки) — 400, а не Prisma-оператор в where', () => {
    // Express разбирает category[not]=x в {not:'x'} — раньше это
    // уходило в prisma.where публичного GET /library как оператор.
    expect(() =>
      pipe.transform({ not: 'x' }, { type: 'query', metatype: String, data: 'category' }),
    ).toThrow(BadRequestException);
    expect(() =>
      pipe.transform(['a', 'b'], { type: 'query', metatype: String, data: 'take' }),
    ).toThrow(BadRequestException);
  });

  it('обычные строки, undefined и DTO-объекты проходят как раньше', () => {
    expect(pipe.transform('politics', { type: 'query', metatype: String, data: 'category' })).toBe('politics');
    expect(pipe.transform(undefined, { type: 'query', metatype: String, data: 'category' })).toBeUndefined();
    class SomeQueryDto {}
    const dto = { a: 1 };
    expect(pipe.transform(dto, { type: 'query', metatype: SomeQueryDto as never, data: undefined })).toBe(dto);
    // body не трогаем — там DTO-валидация.
    expect(pipe.transform({ x: 1 }, { type: 'body', metatype: String as never, data: 'x' })).toEqual({ x: 1 });
  });
});

describe('ValidationPipe на высокорисковых DTO', () => {
  const pipe = new ValidationPipe({ transform: true });

  it('КЛЮЧЕВОЙ ТЕСТ: TTS-текст сверх лимита — 400 (ElevenLabs тарифицируется посимвольно)', async () => {
    await expect(
      pipe.transform({ text: 'а'.repeat(2001) }, { type: 'body', metatype: SynthesizeDto }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      pipe.transform({ text: '' }, { type: 'body', metatype: SynthesizeDto }),
    ).rejects.toThrow(BadRequestException);
    const ok = await pipe.transform({ text: 'Привет' }, { type: 'body', metatype: SynthesizeDto });
    expect(ok).toBeInstanceOf(SynthesizeDto);
    expect(ok.text).toBe('Привет');
  });

  it('intake-ответ: не-строка и сверхдлинный текст — 400; длинная голосовая надиктовка (8000) проходит', async () => {
    await expect(pipe.transform({ text: 42 }, { type: 'body', metatype: TextDto })).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ text: 'а'.repeat(8001) }, { type: 'body', metatype: TextDto })).rejects.toThrow(BadRequestException);
    const ok = await pipe.transform({ text: 'а'.repeat(8000) }, { type: 'body', metatype: TextDto });
    expect(ok.text).toHaveLength(8000);
  });

  it('недекорированные DTO проходят без изменений (whitelist выключен намеренно — см. create-app.ts)', async () => {
    class LegacyDto {
      anything!: string;
    }
    const body = { anything: 'x', extra: { not: 'y' } };
    const out = await pipe.transform(body, { type: 'body', metatype: LegacyDto });
    expect(out.anything).toBe('x');
    expect(out.extra).toEqual({ not: 'y' }); // не вырезано — декораторы добавляются точечно
  });
});
