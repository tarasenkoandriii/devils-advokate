// Сверка 2026-09-05 — вывод модели, вернувшийся наблюдением.
//
// НАЙДЕННОЕ. Две сущности, из которых собирается портрет человека,
// целиком создаются моделью:
//
//   • PersonCommunicationTrait — «наблюдаемый коммуникационный профиль».
//     Пишет CommunicationProfileService по расшифровкам; у каждой строки
//     есть `observedFrom` (§3.11 ТЗ прямо требует ссылку на наблюдение)
//     и `generatedByInferenceId`.
//   • BehaviorPrecedent — «известные прецеденты поведения». Пишет
//     PrecedentSearchService по тем же расшифровкам; у каждой строки есть
//     `sourceDescription` и `generatedByInferenceId`.
//
// В четырёх сборщиках контекста обе раскладывались голым текстом под
// заголовками, утверждающими наблюдение. Ни происхождения, ни источника —
// хотя и то и другое лежит в базе.
//
// ЧЕМ ЭТО ХУЖЕ ПРЕДЫДУЩЕЙ НАХОДКИ. В [source-collapse] терялась пометка
// на том, что человек записал сам. Здесь модель получает СОБСТВЕННЫЙ
// прежний вывод, переименованный в наблюдение, и строит на нём
// следующий — а тот, сохранившись, станет «наблюдением» для следующего.
// Цепочка, где каждое звено считает предыдущее фактом, и человека,
// который бы это подтвердил, в ней нет.
//
// ПРАВИЛО В ПРОДУКТЕ УЖЕ БЫЛО, и на стороне ЧЕЛОВЕКА: экран показывает
// прецедент с подписью «Источник: …», а черту профиля — «На основании:
// …». То есть человеку продукт честно говорил, откуда взялось
// наблюдение, а модели — нет. Ровно наоборот к тому, как надо: человек
// хотя бы помнит, что сам нажимал «найти прецеденты».

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { derivedLine, derivedList, hasDerived, DERIVED_CONTEXT_INSTRUCTION } from '../common/derived-context';

const API_SRC = join(__dirname, '..');
const TMA_SRC = join(__dirname, '../../../tma/src');

function code(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Сервисы, которые кладут выведенное моделью в промпт. Список не
 * захардкожен: пятый обязан либо нести происхождение, либо уронить
 * проверку. */
function servicesUsingDerived(): string[] {
  const found: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.service.ts')) {
        const src = code(API_SRC, r);
        if (/\$\{traitsText\}|\$\{precedentsText\}/.test(src)) found.push(r);
      }
    }
  })(API_SRC, '');
  return found;
}

describe('Вывод модели не выдаётся за наблюдение', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: строка несёт и происхождение, и источник', () => {
    const line = derivedLine({ text: 'Просит конкретные цифры', source: 'разговор 12 марта' });
    expect(line).toMatch(/вывод модели/);
    expect(line).toMatch(/разговор 12 марта/);
    expect(line).toContain('Просит конкретные цифры');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: источника нет — сказано, что его нет, а не опущено', () => {
    // Источник и есть то, чем вывод отличается от выдумки: «по разговору
    // 12 марта» проверяемо, «модель так решила» — нет. Строка без
    // источника, поданная как обычная, была бы худшим из двух.
    const line = derivedLine({ text: 'Просит цифры', source: null });
    expect(line).toMatch(/вывод модели, источник не записан/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: модели сказано, что делать с пометкой', () => {
    expect(DERIVED_CONTEXT_INSTRUCTION).toMatch(/прежние выводы этой же системы/);
    expect(DERIVED_CONTEXT_INSTRUCTION).toMatch(/Не считай их установленными фактами/);
    // Прямой запрет на самую частую форму подмены: «он всегда так
    // делает», выведенное из одного разбора расшифровки.
    expect(DERIVED_CONTEXT_INSTRUCTION).toMatch(/«делает всегда»/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: нет выведенного — нет и инструкции', () => {
    // Лишний текст в промпте размывает то, что модель обязана прочитать.
    expect(hasDerived([], [])).toBe(false);
    expect(hasDerived([], [{ text: 'x', source: null }])).toBe(true);
    expect(derivedList([])).toBe('');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один сборщик контекста не подаёт выведенное как наблюдение', () => {
    const services = servicesUsingDerived();
    expect(services.length).toBeGreaterThanOrEqual(4);
    for (const rel of services) {
      const src = code(API_SRC, rel);
      expect({ rel, marks: /derivedList\(/.test(src) }).toEqual({ rel, marks: true });
      // Не «упоминается в файле»: имя остаётся в строке импорта и после
      // того, как из промпта его убрали. Мутация это показала — третий
      // раз за сессию тот же способ обмануть проверку. Считаем
      // употребления ВНЕ импорта.
      const uses = src
        .split('\n')
        .filter((line) => line.includes('DERIVED_CONTEXT_INSTRUCTION') && !line.trimStart().startsWith('import'));
      expect({ rel, uses: uses.length }).not.toEqual({ rel, uses: 0 });
      // Заголовок больше не утверждает наблюдение сам по себе.
      expect({ rel, claims: /Наблюдаемый коммуникационный профиль|Известные прецеденты поведения/.test(src) })
        .toEqual({ rel, claims: false });
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: связи НЕ помечены как вывод — их вводит человек руками', () => {
    // Пометить всё подряд «выводом модели» было бы такой же неправдой:
    // Relationship создаёт RelationshipsService по прямому действию
    // человека, и приписать это модели значит снять с продукта то, что он
    // действительно знает.
    const src = code(API_SRC, 'relationships/relationships.service.ts');
    expect(src).toMatch(/relationship\.create/);
    expect(src).not.toMatch(/derivedList\(/);
    for (const rel of servicesUsingDerived()) {
      const line = code(API_SRC, rel)
        .split('\n')
        .find((l) => /relationshipsText = /.test(l));
      if (line) expect({ rel, line, marked: /derivedList\(/.test(line) }).toEqual({ rel, line, marked: false });
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило, которое в продукте уже было, не сломано', () => {
    // Экран показывает человеку и «Источник: …» у прецедента, и «На
    // основании: …» у черты профиля. Это точка отсчёта: именно поэтому
    // находка формулируется как «человеку говорили, а модели нет».
    const src = readFileSync(join(TMA_SRC, 'components/PeopleSection.tsx'), 'utf8');
    expect(src).toMatch(/Источник: \{p\.sourceDescription\}/);
    expect(src).toMatch(/На основании: \{t\.observedFrom\}/);
  });
});
