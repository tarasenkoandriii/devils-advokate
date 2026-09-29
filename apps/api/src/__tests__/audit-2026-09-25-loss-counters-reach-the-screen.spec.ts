// Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — счётчик
// «сколько потеряно», который никто не показывает.
//
// Измерение этой сверки: пять счётчиков вида «сколько отброшено / до
// чего не дошли» уходят клиенту, и НИ ОДИН из них не читался ни одним
// экраном. Сервер считал честно, а человек видел итог, из которого
// потеря уже вычтена, — то есть ровно то, что продукт себе запрещает:
// пробел, выглядящий как отсутствие находок.
//
// Правило узкое намеренно. «Каждое поле ответа обязано быть на экране»
// кричало бы на восемьдесят полей, из которых большинство — служебные
// (идентификаторы задач, внутренние ссылки). Здесь проверяются только
// те, чьё ИМЯ говорит о потере: отброшено, не дошли, осталось закрытым.

import * as fs from 'fs';
import * as path from 'path';

const TMA = path.join(__dirname, '..', '..', '..', 'tma', 'src');
const ADMIN = path.join(__dirname, '..', '..', '..', 'admin', 'src');

/** Счётчики потери, которые обязаны доходить до экрана, и где именно
 * человек их читает. Список — решение, а не перечень: новый счётчик
 * появится либо здесь, либо в списке «не для экрана» ниже. */
const MUST_REACH_SCREEN: Array<{ field: string; why: string }> = [
  { field: 'depthExhausted', why: 'обход цепочки копий остановился по пределу — «не всё закрыто», самая существенная новость после отзыва согласия' },
  { field: 'droppedUnverifiable', why: 'находки, отброшенные проверкой цитат: без них «расхождений не найдено» читается как «их нет»' },
];

/** Счётчики, которым экран не нужен, и почему. Короткий список
 * намеренно: каждая строка здесь — место, где человек чего-то не узнает. */
const NOT_FOR_SCREEN: Array<{ field: string; why: string }> = [
  { field: 'profilesRevoked', why: 'внутреннее число обхода: человеку показываются копии (`copiesRevoked`), а сам корневой профиль он и так видит помеченным' },
];

function clientSources(): string {
  let all = '';
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) all += fs.readFileSync(p, 'utf8');
    }
  };
  walk(TMA);
  walk(ADMIN);
  return all;
}

/** Поле считается ДОШЕДШИМ, если клиент его читает у объекта, а не
 * просто упоминает в комментарии. */
function readsField(src: string, field: string): boolean {
  return new RegExp(`[.?]${field}\\b`).test(src) || new RegExp(`\\b${field}\\s*[,}:]`).test(src);
}

describe('[the-sentence-did-not-look-at-the-fact] счётчики потери доходят до экрана', () => {
  const src = clientSources();

  /** Один отбор для утверждения и для пробы: иначе мутация «пусть
   * пропавших всегда ноль» проходит насквозь, а проба рядом продолжает
   * зеленеть, проверяя соседнее выражение. Урок [server-said-which-day]
   * и [decisions-spoke-machine]. */
  const missingOf = (fields: string[]) => fields.filter((f) => !readsField(src, f));

  it('КЛЮЧЕВОЙ ТЕСТ: каждый счётчик из списка действительно читается клиентом', () => {
    expect(missingOf(MUST_REACH_SCREEN.map((f) => f.field))).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: тот же отбор находит отсутствующее поле', () => {
    expect(missingOf(['poleKotorogoNetVoobsche'])).toEqual(['poleKotorogoNetVoobsche']);
  });

  it('у каждой стороны решения записана причина', () => {
    for (const f of [...MUST_REACH_SCREEN, ...NOT_FOR_SCREEN]) expect(f.why.length).toBeGreaterThan(40);
    expect(MUST_REACH_SCREEN.length).toBeGreaterThan(0);
  });
});
