// Сверка 2026-09-06 — прогноз без автора и совет из пустоты.
//
// НАЙДЕННОЕ, ПЕРВОЕ. Прогноз погоды приходит от ОДНОГО ИЗ ДВУХ
// сервисов: Windy (платный, по ключу) и Open-Meteo (бесплатный,
// запасной). Переключение между ними было молчаливым: тип результата
// автора не нёс, колонки под него не было, экран его не показывал.
// Человек читал «ясно, 18 °C», не зная, чей это прогноз, — при том что
// весь остальной продукт называет опору у каждого вывода
// ([partial-basis], [source-collapse]). И если ключ Windy просрочен,
// продукт уходит на запасной сервис НАВСЕГДА, и не узнает об этом
// никто — та же форма, что у планового задания, которое забыли
// применить.
//
// НАЙДЕННОЕ, ВТОРОЕ (хуже первого). Когда сервис ОТВЕЧАЛ, но данных на
// дату не давал, оба клиента возвращали строку `'нет данных'` в поле
// `condition`. Эта строка:
//
//  • сохранялась в базу как описание погоды;
//  • уходила в промпт строкой «Погода: нет данных»;
//  • и модель выдавала по ней рекомендацию — PROCEED или RECONSIDER, с
//    обоснованием. Человек читал совет о СВОЕЙ ВСТРЕЧЕ, построенный из
//    отсутствия данных, и отличить его от настоящего было нельзя.
//
// Форма знакомая: ПРОБЕЛ ВЫГЛЯДИТ КАК ВЫВОД. Инструмент для неё в
// проекте есть с пункта [failure-looks-empty] — здесь он применён не
// был.
//
// И третье, мельче: предупреждение о погоде в форме создания встречи
// показывалось только при RECONSIDER. Его молчание человек читает как
// «с погодой всё в порядке» — а при пустом ответе сервиса это не так.
//
// ЧТО НЕ ЧИНИЛОСЬ: сам выбор «Windy первым» не трогался — обоснование
// (бесплатный сервис без ключа надёжнее покрывает платный, чем
// наоборот) записано в сервисе и остаётся в силе.

import { forecastHasData, noForecastDataReason } from '../weather-forecast/open-meteo-client';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const TMA = join(SRC, '..', '..', 'tma', 'src');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

describe('Сверка [forecast-without-source]: у прогноза есть автор, у совета — опора', () => {
  describe('правило на своих данных', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: пустой ответ сервиса — это «нет данных», а не погода', () => {
      expect(forecastHasData({ temperatureCelsius: null, condition: null })).toBe(false);
    });

    it('половинчатый ответ данными считается: температура без описания — это уже что-то', () => {
      expect(forecastHasData({ temperatureCelsius: 18, condition: null })).toBe(true);
      expect(forecastHasData({ temperatureCelsius: null, condition: 'ясно' })).toBe(true);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: текст вместо совета называет автора ответа и не выдаёт пустоту за погоду', () => {
      const windy = noForecastDataReason('windy');
      const om = noForecastDataReason('open-meteo');
      expect(windy).toContain('Windy');
      expect(om).toContain('Open-Meteo');
      for (const t of [windy, om]) {
        expect(t).toContain('данных на это время не дал');
        expect(t).toContain('выводом из пустоты');
        // Ни один текст не утверждает, что погода хорошая или плохая.
        expect(t).not.toMatch(/ясно|дожд|хорош|плох/i);
      }
    });
  });

  describe('строка «нет данных» больше не значение', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: ни один клиент прогноза её не возвращает', () => {
      for (const f of ['open-meteo-client.ts', 'windy-client.ts']) {
        const code = read(SRC, 'weather-forecast', f).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toContain("'нет данных'");
      }
    });

    /** «Без данных модель не вызывается» проверяется ПОВЕДЕНИЕМ, в
     * weather-forecast.service.spec.ts: фейковый роутер запоминает
     * последний запрос, и после пустого ответа сервиса он остаётся
     * null. Текстовая проверка того же самого стояла здесь и убрана —
     * дублировать поведенческий тест текстом ровно то, против чего
     * стоит проверка проверок (audit-2026-09-04-guard-audit). */

    /** «Половинчатый ответ не подставляет пустоту вместо погоды»
     * проверяется ПОВЕДЕНИЕМ, в weather-forecast.service.spec.ts, на
     * реальном промпте. Этот тест нашёл по ходу ещё одно: отсутствующий
     * код погоды давал строку «код undefined», и она сохранялась как
     * ОПИСАНИЕ ПОГОДЫ и показывалась человеку. Починено там же. */
  });

  describe('автор прогноза', () => {
    /** «Оба клиента подписывают ответ» и «автор доезжает до базы»
     * проверяются ПОВЕДЕНИЕМ: windy-client.spec.ts сверяет весь
     * результат с `source: 'windy'`, weather-forecast.service.spec.ts —
     * сохранённую строку с `source: 'open-meteo'`. Текстовые двойники
     * убраны. */
    it('колонка автора объявлена в схеме — это данные, а не поведение', () => {
      expect(read(SRC, '..', 'prisma', 'schema.prisma')).toContain('  source String?');
    });

    it('миграция аддитивна там, где может, и называет две неаддитивные части', () => {
      const sql = read(SRC, '..', 'prisma', 'manual-migrations', 'weather_source_2026_09_06.sql');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "source"');
      expect(sql).toContain('ALTER COLUMN "condition" DROP NOT NULL');
      expect(sql).toContain('ALTER COLUMN "recommendation" DROP NOT NULL');
      // Советы, построенные на строке «нет данных», снимаются, а не
      // остаются лежать выводами о встречах людей.
      expect(sql).toContain('SET "recommendation" = NULL');
    });
  });

  describe('что человек видит', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: экран не печатает вердикт там, где совета нет', () => {
      const ws = read(TMA, 'components', 'WeatherForecastSection.tsx');
      expect(ws).toContain('Совета нет — не из чего');
      expect(ws).toContain('Источник прогноза:');
      expect(ws).toContain('Описание погоды сервис не дал');
    });

    it('КЛЮЧЕВОЙ ТЕСТ: молчание предупреждения в форме встречи больше не читается как «всё в порядке»', () => {
      const sched = read(TMA, 'components', 'SchedulerSection.tsx');
      expect(sched).toContain("weatherPreview.recommendation === null");
      expect(sched).toContain('Это не значит, что с погодой всё в');
    });
  });
});
