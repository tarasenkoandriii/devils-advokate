// Сверка 2026-09-05, серверная половина — происхождение факта теряется
// ровно там, где оно важнее всего.
//
// НАЙДЕННОЕ. Продукт заставляет человека выбрать происхождение КАЖДОГО
// факта о другом человеке: 🟢 личная запись (видел/слышал сам), 🔵
// публичный факт, ⚪ моё предположение. Это одна из подписных идей
// продукта — и держалась она ровно до момента использования. Четыре
// сервиса собирали контекст так:
//
//   facts.map((f) => `- ${f.content}`).join('\n')
//   → «Известные факты о фигуранте: …»
//
// То есть ⚪ «моё предположение» уходило модели как «известный факт»,
// неотличимо от записи со слов и публичного факта. Модель строила на нём
// гипотезы о мотивах, портрет собеседника, стальной аргумент — и
// возвращала выводы, у которых в основании лежит догадка самого
// пользователя. Замкнутый круг: догадка возвращается выводом, а человек,
// забывший, что сам её записал, читает её как находку.
//
// ПРАВИЛО В ПРОДУКТЕ УЖЕ БЫЛО: `SchedulerAdviceService` фильтрует по
// `sourceType = PERSONAL_RECORD` прямо в SQL и называет блок «строго со
// слов пользователя». Снова знакомый вид — правило есть, просто не везде.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { FactSourceType } from '@prisma/client';
import {
  factLine,
  factsBlock,
  factsBlockWithInstruction,
  hasGuess,
  FACT_PROVENANCE_INSTRUCTION,
} from '../common/fact-provenance';

const API_SRC = join(__dirname, '..');

/** Комментарии прочь перед разбором КОДА: за эту сессию проверки шесть
 * раз ловили собственный объяснительный текст, а старые формулировки
 * процитированы в комментариях как «было раньше». */
function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Все сервисы, которые вообще читают факты о человеке. Список не
 * захардкожен: новый потребитель обязан либо нести происхождение, либо
 * уронить эту проверку. */
function servicesReadingFacts(): string[] {
  const found: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.service.ts') && /personFact\.findMany\(/.test(code(r))) found.push(r);
    }
  })(API_SRC, '');
  return found;
}

const guess = { content: 'наверное, он торопится', sourceType: FactSourceType.USER_GUESS };
const record = { content: 'сказал, что уезжает в мае', sourceType: FactSourceType.PERSONAL_RECORD };
const publicFact = { content: 'работает в НИИ', sourceType: FactSourceType.PUBLIC_FACT };

describe('Происхождение факта: догадка не выдаётся за факт', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: догадка помечена догадкой, а не смягчена', () => {
    // «Непроверенное наблюдение» звучит мягче и означает другое. Человек
    // выбрал слово «предположение» — модель должна получить его же.
    const line = factLine(guess);
    expect(line).toMatch(/ДОГАДКА пользователя/);
    expect(line).toMatch(/не проверено/);
    expect(line).toContain(guess.content);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: три происхождения различимы между собой', () => {
    const block = factsBlock([record, publicFact, guess]);
    expect(block).toMatch(/со слов пользователя/);
    expect(block).toMatch(/публичный факт/);
    expect(block).toMatch(/ДОГАДКА/);
    // И ни одно не потерялось: догадки не выбрасываются — человек
    // записал их не случайно (урок [own-input]).
    expect(block.split('\n')).toHaveLength(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: модели сказано, ЧТО делать с пометкой', () => {
    // Пометка без инструкции — украшение. Тот же приём, что в
    // [partial-basis]: без прямого запрета оговорка ничего не меняет.
    expect(FACT_PROVENANCE_INSTRUCTION).toMatch(/не опирайся на него как на факт/);
    expect(FACT_PROVENANCE_INSTRUCTION).toMatch(/не выдавай его обратно как подтверждённое/);
    expect(factsBlockWithInstruction([guess])).toContain(FACT_PROVENANCE_INSTRUCTION);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: когда догадок нет — инструкции нет', () => {
    // Лишний текст в промпте не бесплатная осторожность: он размывает
    // то, что модель обязана прочитать.
    expect(hasGuess([record, publicFact])).toBe(false);
    expect(factsBlockWithInstruction([record, publicFact])).not.toContain(FACT_PROVENANCE_INSTRUCTION);
    expect(factsBlockWithInstruction([])).toBe('');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один сервис не отдаёт факты модели без происхождения', () => {
    // Правило меряется по всему дереву: пятый потребитель должен уронить
    // проверку, а не тихо повторить изъян.
    const services = servicesReadingFacts();
    expect(services.length).toBeGreaterThanOrEqual(4);

    // Правило — о содержимом факта, покидающем сервис: в промпт модели
    // или наружу человеку. Сервис, который просто хранит и отдаёт строки
    // целиком (CRUD), несёт происхождение сам собой — там придираться
    // не к чему, и притворяться, что проверяем, нельзя.
    const offenders: string[] = [];
    for (const rel of services) {
      const src = code(rel);
      const usesContent = /\$\{f\.content\}|content: f\.content/.test(src);
      if (!usesContent) continue;
      // Законных способов ДВА, и второй не хуже первого: либо каждая
      // строка несёт своё происхождение, либо выборка сужена до одного
      // происхождения на уровне SQL — как в SchedulerAdviceService,
      // который берёт только записи со слов и так и говорит. Требовать
      // пометку там, где догадок в выборке нет по построению, значило бы
      // требовать формальность вместо смысла.
      const marksEachLine = /factsBlockWithInstruction\(|factsBlock\(|f\.sourceType/.test(src);
      const narrowsInSql = /sourceType: FactSourceType\.[A-Z_]+/.test(src);
      if (!marksEachLine && !narrowsInSql) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило, которое в продукте уже было, не сломано', () => {
    // SchedulerAdviceService фильтрует догадки на уровне SQL и говорит
    // об этом человеку словами «строго со слов пользователя». Это точка
    // отсчёта: именно поэтому «правило было, просто не везде» — верное
    // описание находки, а не оправдание.
    const src = code('scheduler-advice/scheduler-advice.service.ts');
    expect(src).toMatch(/sourceType: FactSourceType\.PERSONAL_RECORD/);
    expect(src).toMatch(/строго со слов пользователя/);
  });

  it('заголовок блока больше не обещает «известные факты»', () => {
    // Слово «известные» над списком, где лежат догадки, — то же
    // обещание полноты, что в [partial-basis].
    for (const rel of servicesReadingFacts()) {
      expect({ rel, claims: /Известные факты/.test(code(rel)) }).toEqual({ rel, claims: false });
    }
  });
});
