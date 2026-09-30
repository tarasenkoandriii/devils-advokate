// Сверка 2026-09-30 — кнопка, названную средством, и чего она не берёт.
//
// НАЙДЕНО. `DELETE /privacy/person/:id` отвечал `{ deleted: true }`.
// Реестров «что остаётся после удаления» в проекте было три — у
// аккаунта, у проекта и у служебной задачи AI; у ПЕРСОНЫ ни одного.
// При этом реестр последствий отзыва согласия PERSON_RESEARCH прямо
// направляет человека к этой кнопке как к средству: «Удалить данные о
// конкретном человеке можно отдельной кнопкой — здесь же, в Центре
// приватности».
//
// А остаётся немало: девять связей объявлены `onDelete: SetNull`, то
// есть строка переживает человека с `personId = null`. Среди них не
// только материалы пользователя (его реальные реплики в расшифровке,
// аргументы, скрипты), но и СИНТЕЗ О НЁМ: сессии спарринга, где
// продукт отвечал за него, сгенерированные реакции «как посмотрел бы
// он», темы, про которые продукт решил, что он их прощупывает, — с
// числовой уверенностью.
//
// ЧТО ПРОВЕРЯЕТСЯ. ЗАМКНУТОСТЬ ПО СХЕМЕ: каждая связь модели с
// `Person` обязана быть либо каскадной (уходит), либо названной в
// реестре остатка. Новая связь с `SetNull`, добавленная и забытая,
// роняет эту сверку — именно этого у персоны и не было, в отличие от
// проекта и аккаунта.
//
// ЧЕГО ЭТА СВЕРКА НЕ ДЕЛАЕТ. Она не решает, что из остатка ДОЛЖНО
// удаляться: два класса остатка названы полем `kind`, и выбор между
// «это работа человека» и «это синтез о третьем лице» — продуктовое
// решение владельца, записанное в TODO.md. Здесь закрыта честность, а
// не поведение.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PERSON_REMOVED_HERE,
  PERSON_RESIDUE,
  PERSON_RESIDUE_NOTE,
  PERSON_RESIDUE_OUTSIDE_SCHEMA,
  personNotRemovedHere,
} from '../privacy-center/person-deletion-impact';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Все связи «модель → Person» из схемы, с правилом удаления. Разбор
 * по СХЕМЕ, а не по списку в голове: список в голове и был причиной,
 * по которой девять связей никто не пересчитал. */
function personRelations(): Array<{ model: string; field: string; onDelete: string }> {
  const out: Array<{ model: string; field: string; onDelete: string }> = [];
  const re = /^\s*(\w+)\s+Person\??\s+@relation\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SCHEMA))) {
    const before = SCHEMA.slice(0, m.index);
    const modelMatch = /model (\w+) \{[^]*$/.exec(before.slice(before.lastIndexOf('\nmodel ')));
    const model = modelMatch ? modelMatch[1] : '?';
    const onDelete = /onDelete:\s*(\w+)/.exec(m[2])?.[1] ?? 'DEFAULT';
    out.push({ model, field: m[1], onDelete });
  }
  return out;
}

describe('[the-button-was-named-as-the-remedy] что остаётся после удаления записи о человеке', () => {
  it('проба механизма: разбор схемы действительно находит связи с Person', () => {
    const rels = personRelations();
    // Девятнадцать на 2026-09-30. Число живёт здесь, чтобы следующая
    // сверка начинала с факта, а ноль не читался как чистота.
    expect(rels.length).toBe(19);
    expect(rels.filter((r) => r.onDelete === 'DEFAULT')).toEqual([]);
    expect(rels.some((r) => r.model === 'PersonFact' && r.onDelete === 'Cascade')).toBe(true);
    expect(rels.some((r) => r.model === 'SparringSession' && r.onDelete === 'SetNull')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждая связь либо уходит каскадом, либо названа в реестре остатка', () => {
    const named = new Set(PERSON_RESIDUE.map((r) => `${r.model}.${r.field}`));
    const unaccounted = personRelations()
      .filter((r) => r.onDelete !== 'Cascade')
      .filter((r) => !named.has(`${r.model}.${r.field}`))
      .map((r) => `${r.model}.${r.field} (${r.onDelete})`);
    expect(unaccounted).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр не шире схемы — запись, пережившая свою связь, это ложное обещание', () => {
    const inSchema = new Set(personRelations().map((r) => `${r.model}.${r.field}`));
    const stale = PERSON_RESIDUE.filter((r) => !inSchema.has(`${r.model}.${r.field}`)).map(
      (r) => `${r.model}.${r.field}`,
    );
    expect(stale).toEqual([]);
    // И ни одна каскадная связь не названа остатком: сказать «остаётся»
    // о том, что уходит, — обман в другую сторону.
    const cascaded = new Set(
      personRelations()
        .filter((r) => r.onDelete === 'Cascade')
        .map((r) => `${r.model}.${r.field}`),
    );
    expect(PERSON_RESIDUE.filter((r) => cascaded.has(`${r.model}.${r.field}`)).map((r) => r.model)).toEqual([]);
  });

  it('у каждой записи остатка сказано, ЧТО остаётся, и к какому классу это относится', () => {
    expect(PERSON_RESIDUE.filter((r) => r.what.trim().length < 40).map((r) => r.model)).toEqual([]);
    // Два класса, и оба представлены: если бы остался один, оговорка
    // ниже описывала бы различие, которого нет.
    const kinds = new Set(PERSON_RESIDUE.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['материал-пользователя', 'синтез-о-человеке']);
    expect(PERSON_RESIDUE_NOTE.length).toBeGreaterThan(150);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: остаток, не видимый по схеме, назван отдельно', () => {
    // `AIInference` не связана с `Person` ни одной ссылкой, поэтому
    // сверка по схеме её не найдёт НИКОГДА — и именно поэтому она
    // опаснее прочего остатка. Пустой список здесь означал бы, что
    // замкнутость по схеме принята за полноту.
    expect(PERSON_RESIDUE_OUTSIDE_SCHEMA.length).toBeGreaterThan(0);
    expect(PERSON_RESIDUE_OUTSIDE_SCHEMA.filter((l) => l.trim().length < 80)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человеку уезжает и то, что удалено, и то, что осталось', () => {
    // Только «что осталось» читалось бы как «не удалилось ничего»;
    // только «что удалено» — как «забрали всё».
    expect(PERSON_REMOVED_HERE.length).toBeGreaterThan(2);
    const lines = personNotRemovedHere();
    expect(lines.length).toBe(PERSON_RESIDUE.length + PERSON_RESIDUE_OUTSIDE_SCHEMA.length);
    expect(lines.filter((l) => l.trim().length === 0)).toEqual([]);
  });
});
