// Сверка [log-says-we-saw-it] 2026-09-24 — правила НА ДАННЫХ, отдельным
// файлом.
//
// ПОЧЕМУ ОТДЕЛЬНО. Сторож проверок (`audit-2026-09-04-guard-audit.spec.ts`)
// считает `toContain`/`toMatch` в каждом файле, который читает исходники,
// — и сам же называет свою погрешность: утверждения на МАССИВАХ, лежащие
// рядом с таким чтением, завышают счёт, не опираясь ни на какой текст.
// Мера уже применялась в [scope-not-applied] и записана в сторо́же как
// правильная: разделить файл, а не выключать инструмент и не сокращать
// число ради числа.
//
// Здесь — утверждения о СЛОВАРЕ (`common/audit-claim.ts`), которые
// никакого исходника не читают.
//
// И ОТДЕЛЬНАЯ ЗАМЕТКА, СТОЯЩАЯ ТОГО, ЧТОБЫ ОСТАТЬСЯ. Первая редакция
// этого файла называла имя функции чтения ДОСЛОВНО — вот в этом самом
// абзаце, объясняя, как работает сторож. Сторож ищет это имя ПО ТЕКСТУ
// файла и не отличает вызов от упоминания: файл, не читающий ни одного
// исходника, попал в счёт из-за собственного комментария, и разделение
// вместо уменьшения счёта его увеличило. Ровно тот урок, который сторож
// и охраняет: проверка по тексту подтверждает наличие СЛОВА. Имя здесь
// теперь не названо.

import {
  SELF_REPORTED_ACTIONS,
  isSelfReportedAction,
  AUDIT_STATUS_LETTER_LEGACY,
  AUDIT_AI_NOTICE_LEGACY,
  AUDIT_STATUS_LETTER_MARKED_SENT,
  AUDIT_AI_NOTICE_MARKED_SHOWN,
  AUDIT_STATUS_LETTER_ANY,
} from '../common/audit-claim';

describe('[log-says-we-saw-it]: словарь утверждений', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: прежние имена остались в словаре НА ЧТЕНИЕ', () => {
    // Как только они из словаря исчезнут, чеклист закрытия вакансии
    // перестанет видеть старые строки журнала и молча объявит, что этим
    // людям не ответили. Потеря истории читается как факт о людях.
    expect(SELF_REPORTED_ACTIONS).toContain(AUDIT_STATUS_LETTER_LEGACY);
    expect(SELF_REPORTED_ACTIONS).toContain(AUDIT_AI_NOTICE_LEGACY);
    expect(AUDIT_STATUS_LETTER_ANY).toContain(AUDIT_STATUS_LETTER_LEGACY);
    expect(AUDIT_STATUS_LETTER_ANY).toContain(AUDIT_STATUS_LETTER_MARKED_SENT);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: наблюдение не попадает в утверждения, и наоборот', () => {
    // Граница проверяется с обеих сторон: и что утверждения опознаны, и
    // что наблюдения НЕ опознаны как утверждения. Правило, которое
    // говорит «да» на всё, не сторожит ничего.
    expect(isSelfReportedAction(AUDIT_AI_NOTICE_MARKED_SHOWN)).toBe(true);
    expect(isSelfReportedAction(AUDIT_STATUS_LETTER_MARKED_SENT)).toBe(true);
    expect(isSelfReportedAction('candidate_consent.revoked_by_recruiter')).toBe(true);
    // Продукт сам совершил эти действия и потому знает, что они были.
    expect(isSelfReportedAction('candidate_consent.revoked_by_candidate')).toBe(false);
    expect(isSelfReportedAction('offer.withdrawn')).toBe(false);
    expect(isSelfReportedAction('engagement.accepted')).toBe(false);
    expect(isSelfReportedAction('candidate.added_to_project')).toBe(false);
    expect(isSelfReportedAction('bias_export.generated')).toBe(false);
  });
});
