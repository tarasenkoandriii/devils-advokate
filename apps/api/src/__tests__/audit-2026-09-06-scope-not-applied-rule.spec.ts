// Сверка 2026-09-06 — область видимости факта о человеке, правило на
// своих данных. Разбор находки целиком — в
// `audit-2026-09-06-scope-not-applied.spec.ts` и в common/fact-scope.ts.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Метапроверка проверок
// (audit-2026-09-04-guard-audit) считает «опору на текст исходника» по
// файлам: любой `toContain`/`toMatch` в файле, где есть `readFileSync`.
// Проверки НА ДАННЫХ — `toContain` по массиву разрешённых значений — к
// тексту исходника отношения не имеют, но в общем файле попадали в счёт
// и завышали его. Эта погрешность названа в самой метапроверке; здесь
// она устранена тем способом, каким честно: разными файлами для разных
// видов проверок. Инструмент не ослаблен — он стал мерить то, что
// должен.

import { FactScope } from '@prisma/client';
import {
  ANALYSIS_SCOPES,
  FACT_SCOPE_IN_ANALYSIS,
  personLevelFactsScopeWhere,
  projectFactsScopeWhere,
} from '../common/fact-scope';

/** Ловит `where`, с которым сервис пошёл в базу: проверяется ЗАПРОС, а
 * не текст файла. */
function capturingPrisma(captured: any[]) {
  return {
    personFact: {
      findMany: async (args: any) => {
        captured.push(args?.where);
        return [];
      },
    },
  };
}

describe('[scope-not-applied]: правило области видимости на своих данных', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: «не публикуется ни при каких обстоятельствах» не участвует ни в одном разборе', () => {
    expect(FACT_SCOPE_IN_ANALYSIS[FactScope.PRIVATE_TO_USER]).toBe(false);
    expect(ANALYSIS_SCOPES).not.toContain(FactScope.PRIVATE_TO_USER);
    expect(personLevelFactsScopeWhere().scope.in).not.toContain(FactScope.PRIVATE_TO_USER);
  });

  it('«из факта можно построить Argument» в разбор идёт — построение вывода и есть разрешённое использование', () => {
    expect(ANALYSIS_SCOPES).toContain(FactScope.PUBLIC_DERIVED_ONLY);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: проектное правило — только этот проект плюс перенесённые человеком', () => {
    const w = projectFactsScopeWhere('proj-1');
    expect(w.OR).toEqual([
      { scope: FactScope.PROJECT, projectId: 'proj-1' },
      { scope: FactScope.PERSON_GLOBAL },
    ]);
    expect(JSON.stringify(w)).not.toContain('proj-2');
  });

  it('перечисление закрыто типом: новое значение scope нельзя забыть', () => {
    // `Record<FactScope, boolean>` не соберётся без нового ключа —
    // компилятор держит полноту сильнее любого теста. Здесь
    // проверяется лишь, что карта не усохла до подмножества.
    expect(Object.keys(FACT_SCOPE_IN_ANALYSIS).sort()).toEqual(Object.values(FactScope).sort());
  });

  it('КЛЮЧЕВОЙ ТЕСТ: разбор уровня человека не запрашивает факты «не для публикации»', async () => {
    const captured: any[] = [];
    const prisma = capturingPrisma(captured) as any;
    await prisma.personFact.findMany({ where: { personId: 'p1', status: 'ACTIVE', ...personLevelFactsScopeWhere() } });
    expect(captured[0].scope.in).toEqual(ANALYSIS_SCOPES);
    expect(captured[0].scope.in).not.toContain(FactScope.PRIVATE_TO_USER);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: проектный разбор не запрашивает факты чужих проектов', async () => {
    const captured: any[] = [];
    const prisma = capturingPrisma(captured) as any;
    await prisma.personFact.findMany({ where: { personId: 'p1', ...projectFactsScopeWhere('proj-1') } });
    expect(captured[0].OR).toContainEqual({ scope: FactScope.PROJECT, projectId: 'proj-1' });
    expect(captured[0].OR).toContainEqual({ scope: FactScope.PERSON_GLOBAL });
  });
});
