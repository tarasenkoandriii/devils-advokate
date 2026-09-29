// Сверка 2026-09-06 — текст резался молча, а честная записка об этом
// сообщала неправду.
//
// НАЙДЕННОЕ, ПЕРВОЕ. `fetchUrlText()` — единственный в проекте
// загрузчик страниц по ссылке пользователя — возвращал ОДНУ СТРОКУ,
// обрезанную по потолку в последней строчке тела. Ни один из девяти
// вызывающих не мог узнать, обрезана она или нет. А читают через неё:
// страницу компании (факты в досье), объявление о вакансии, источник
// для проверки утверждения из разговора, страницу с ценой для крупной
// покупки, источник по инвестиции, медицинский источник. Продукт
// разбирал первые N знаков и говорил о них как обо всей странице.
//
// НАЙДЕННОЕ, ВТОРОЕ, и оно неприятнее. Валидатор запроса на вставку
// вакансии пропускает 20 000 знаков, а запись режет до 12 000 — молча.
// Человек вставлял объявление на 15 000 знаков, получал созданную
// вакансию и НИГДЕ не узнавал, что три тысячи знаков в продукт не
// попали. Дальше по этому обрезку считается `contentHash` (то есть и
// склейка дублей), идёт сверка с CV, ищутся признаки мошенничества и
// собираются основания для листа условий.
//
// И САМОЕ ХУДШЕЕ ИЗ ТРЁХ. Механизм честного отчёта в продукте есть с
// пункта [input-truncated]: он говорит человеку «в разбор вошли первые
// N знаков из M». Но M он берёт из того, что лежит в базе. То есть
// после молчаливой обрезки на входе ЧЕСТНАЯ ЗАПИСКА СООБЩАЛА «вошли
// 12 000 из 12 000» — и была неправдой, не зная об этом. Правило
// честности, обойдённое молчанием уровнем ниже, не просто не работает
// — оно начинает врать убедительнее, чем молчание.
//
// РЕШЕНИЕ: тот же `takeSource`/`SourceIntake`, что и в
// [input-truncated], применён к границе загрузки и к границе записи.
// Новых механизмов не заводилось — заводить второй способ говорить то
// же самое было бы началом следующего расхождения (урок
// [one-quote-rule], где одно правило жило в пяти экземплярах).

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { takeSource, isTruncatedIntake, intakeNote } from '../common/source-intake';

const API_SRC = join(__dirname, '..');
const TMA = join(API_SRC, '..', '..', 'tma', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('Сверка [stored-text-cut]: обрезка обязана называть себя', () => {
  describe('правило на своих данных', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: отчёт называет и сколько вошло, и сколько было', () => {
      const long = 'я'.repeat(15_000);
      const { text, intake } = takeSource(long, 12_000);
      expect(text.length).toBe(12_000);
      expect(intake.used).toBe(12_000);
      expect(intake.total).toBe(15_000);
      expect(isTruncatedIntake(intake)).toBe(true);
      expect(intakeNote(intake)).toContain('15');
    });

    it('текст, вошедший целиком, никакой записки не порождает', () => {
      const { intake } = takeSource('короткий текст', 12_000);
      expect(isTruncatedIntake(intake)).toBe(false);
      expect(intakeNote(intake)).toBeNull();
    });
  });

  describe('граница загрузки', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: загрузчик больше не отдаёт голую строку', () => {
      const code = readFileSync(join(API_SRC, 'common', 'safe-url-fetch.ts'), 'utf8');
      expect(code).toContain('Promise<{ text: string; intake: SourceIntake }>');
      // Прежняя обрезка на месте возврата не должна вернуться.
      expect(code).not.toContain('return text.slice(');
    });

    it('КЛЮЧЕВОЙ ТЕСТ: ни один вызывающий не принимает результат загрузки как строку', () => {
      // Обход дерева: новый домен, читающий страницу по ссылке, обязан
      // получить отчёт вместе с текстом, а не строку.
      const offenders: string[] = [];
      for (const f of tsFiles(API_SRC)) {
        const code = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        for (const m of code.matchAll(/(\w+)\s*=\s*await fetchUrlText\(/g)) {
          offenders.push(`${f.slice(API_SRC.length + 1)}: ${m[1]} = await fetchUrlText(...)`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('страница, прочитанная не целиком, названа в отчёте сбора досье', () => {
      const code = readFileSync(join(API_SRC, 'employer-dossier', 'employer-dossier.service.ts'), 'utf8');
      expect(code).toContain('truncatedPages');
      expect(code).toContain('isTruncatedIntake(intake)');
    });
  });

  describe('граница записи', () => {
    /** «Текст режется, а длина до обрезки записывается» проверяется
     * ПОВЕДЕНИЕМ, в vacancy-intake.service.spec.ts: вставка текста на
     * 15 000+ знаков даёт сохранённые 12 000 и записанную полную
     * длину. Здесь остаётся только текстовое правило — что прежняя
     * молчаливая обрезка не вернулась. */
    it('прежняя молчаливая обрезка не вернулась в код', () => {
      const code = readFileSync(join(API_SRC, 'vacancy-intake', 'vacancy-intake.service.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
      expect(code).not.toContain('data.rawText.slice(');
    });

    it('колонка длины объявлена в схеме и доезжает до списка вакансий', () => {
      expect(readFileSync(join(API_SRC, '..', 'prisma', 'schema.prisma'), 'utf8')).toContain('rawTextTotalChars Int?');
      const list = readFileSync(join(API_SRC, 'job-search', 'job-search.service.ts'), 'utf8');
      expect(list.slice(list.indexOf('async listVacancies'))).toContain('rawTextTotalChars: true');
    });

    it('миграция аддитивна и не выдумывает длину там, где её не знает', () => {
      const sql = readFileSync(join(API_SRC, '..', 'prisma', 'manual-migrations', 'vacancy_text_total_2026_09_06.sql'), 'utf8');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "rawTextTotalChars"');
      // Заполняется только там, где длину можно утверждать без догадки.
      expect(sql).toContain('LENGTH("rawText") < 12000');
      expect(sql).toContain('NULL здесь честнее');
    });

    it('КЛЮЧЕВОЙ ТЕСТ: экран говорит человеку, что вошло не всё', () => {
      const ws = readFileSync(join(TMA, 'components', 'domains', 'job-search', 'JobSearchWorkspace.tsx'), 'utf8');
      expect(ws).toContain('В продукт вошли первые');
      expect(ws).toContain('конец текста не сохранён');
      expect(ws).toContain('<IntakeNote v={v} />');
    });
  });
});
