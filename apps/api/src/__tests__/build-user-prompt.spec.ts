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
        // Пункт [the-test-failed-by-clock] 2026-09-30: было ровно
        // `Date.now() + 5 суток`, а `deadlineRelative` берёт своё
        // `new Date()` на несколько миллисекунд позже и делает
        // `Math.floor` — то есть получалось «через 4 дня». Тест падал
        // 3 раза из 10 полных прогонов. Час запаса снимает гонку, не
        // меняя проверяемого свойства.
        deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
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
    // Пункт [server-said-which-day] 2026-09-24: было календарное число
    // по UTC. Срок собирается на клиенте как конец МЕСТНОГО дня, и его
    // число по UTC у человека западнее Гринвича на сутки больше — то
    // есть модель получала не тот день, который человек выбрал. Теперь
    // расстояние во времени, и в промпте не должно остаться календаря.
    expect(prompt).toContain('Срок: через 5 дней');
    expect(prompt).not.toMatch(/Срок: \d{4}-\d{2}-\d{2}/);
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
