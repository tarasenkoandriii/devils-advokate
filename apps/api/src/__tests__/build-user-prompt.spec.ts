// Проверяет именно то, ради чего фича 6 вообще связана с фичей 1:
// заполненный DecisionObjective должен попадать в текст, который
// реально уходит модели, а не быть write-only полем в БД.

import { buildUserPrompt } from '../arguments/argument-generation.service';

describe('buildUserPrompt (фича 6 → фича 1)', () => {
  it('без DecisionObjective — только вопрос и цель, как раньше', () => {
    const prompt = buildUserPrompt({ question: 'Стоит ли просить о повышении?', goal: 'Больше денег' }, null);
    expect(prompt).toContain('Вопрос: Стоит ли просить о повышении?');
    expect(prompt).toContain('Цель: Больше денег');
    expect(prompt).not.toContain('Желаемый исход');
  });

  it('с DecisionObjective — все заполненные поля попадают в промпт', () => {
    const prompt = buildUserPrompt(
      { question: 'Стоит ли просить о повышении?', goal: null },
      {
        id: 'obj-1',
        projectId: 'proj-1',
        desiredOutcome: 'Повышение на 20%',
        idealOutcome: 'Повышение на 30% и новая должность',
        minimumAcceptableOutcome: 'Повышение хотя бы на 10%',
        unacceptableOutcome: 'Отказ без объяснений',
        deadline: new Date('2026-12-31T00:00:00.000Z'),
        constraints: ['Бюджет команды урезан в этом квартале'],
        nonNegotiables: ['Остаться в текущей команде'],
        negotiables: ['Готов на удалёнку вместо офиса'],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    );

    expect(prompt).toContain('Желаемый исход: Повышение на 20%');
    expect(prompt).toContain('Идеальный исход: Повышение на 30% и новая должность');
    expect(prompt).toContain('Минимально приемлемый результат: Повышение хотя бы на 10%');
    expect(prompt).toContain('Неприемлемо (красная черта): Отказ без объяснений');
    expect(prompt).toContain('Ограничения: Бюджет команды урезан в этом квартале');
    expect(prompt).toContain('Не подлежит обсуждению: Остаться в текущей команде');
    expect(prompt).toContain('Можно поступиться: Готов на удалёнку вместо офиса');
    expect(prompt).toContain('Срок: 2026-12-31');
  });

  it('с частично заполненным DecisionObjective — пустые поля не создают мусорных строк', () => {
    const prompt = buildUserPrompt(
      { question: 'Q', goal: null },
      {
        id: 'obj-1',
        projectId: 'proj-1',
        desiredOutcome: 'Только это поле заполнено',
        idealOutcome: null,
        minimumAcceptableOutcome: null,
        unacceptableOutcome: null,
        deadline: null,
        constraints: [],
        nonNegotiables: [],
        negotiables: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    );

    expect(prompt).toContain('Желаемый исход: Только это поле заполнено');
    expect(prompt).not.toContain('Идеальный исход');
    expect(prompt).not.toContain('Ограничения');
    expect(prompt).not.toContain('Срок');
  });
});
