// Пункт [decisions-spoke-machine] 2026-09-25 — сами подписи решений и
// поведение `describeDecision`. Файлов эта спека не читает; сверка
// реестра с кодом — в соседней `…-decisions-spoke-machine.spec.ts`.

import { DECISION_LABELS, describeDecision } from '../privacy-center/decision-labels';

describe('[decisions-spoke-machine] подписи решений', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: подпись говорит, КЕМ принято решение — иначе «о вас» и «вы сами» не различить', () => {
    for (const [action, label] of Object.entries(DECISION_LABELS)) {
      expect(label.what.length).toBeGreaterThan(15);
      expect(label.what).not.toContain(action); // не пересказ имени
      expect(['оператор продукта', 'вы сами', 'другая сторона', 'продукт автоматически']).toContain(label.by);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: незнакомое действие НЕ переводится наугад', () => {
    // Выдуманная подпись хуже непонятной: непонятную человек
    // переспросит, а выдуманной поверит.
    const described = describeDecision({
      action: 'something.unknown',
      resource: 'Project',
      resourceId: 'p1',
      createdAt: new Date('2026-09-25T10:00:00Z'),
    });
    expect(described.what).toContain('something.unknown');
    expect(described.what).toContain('не расшифровано');
    expect(described.by).toBeNull();
  });

  it('машинное имя остаётся рядом с подписью — по нему человек и поддержка говорят об одной записи', () => {
    const described = describeDecision({
      action: 'project.frozen',
      resource: 'Project',
      resourceId: 'p1',
      createdAt: new Date('2026-09-25T10:00:00Z'),
    });
    expect(described.action).toBe('project.frozen');
    expect(described.what).toContain('заморожен');
    expect(described.by).toBe('оператор продукта');
    expect(described.at).toBe('2026-09-25T10:00:00.000Z');
  });
});
