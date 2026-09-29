// Пункт [operator-left-a-trace-unsaid] 2026-09-25, серверная половина.
//
// Экранная — в `apps/admin/src/__tests__`, там компонент РИСУЕТСЯ.
// Здесь проверяется то, что считается только на сервере: увидит ли
// человек решение оператора, и что ответ на это берётся из тех же
// реестров, что питают экран человека, а не из второй копии.

import { AUDITED_OPERATOR_ACTIONS } from '../audit-log/operator-actions';
import { OPERATOR_TRACES, OPERATOR_TRACE_ALWAYS, operatorTrace, type OperatorTrace } from '../audit-log/operator-trace';
import { DECISION_LABELS } from '../privacy-center/decision-labels';
import { DECISION_SCOPES, DECISIONS_OUT_OF_SCOPE, DECISION_RESOURCE } from '../privacy-center/decision-scope';

/** След действия — одной функцией на весь файл.
 *
 * Не украшение: сторож [probe-checked-the-neighbour] забраковал первую
 * версию, где пробы трогали только импортированные реестры, то есть
 * соседнее выражение. Теперь и утверждения, и обе пробы идут через одно
 * и то же — и подмена этого «одного» роняет их вместе. */
function traceOf(action: string): OperatorTrace {
  return OPERATOR_TRACES.find((t) => t.action === action) ?? operatorTrace(action);
}

describe('Пункт [operator-left-a-trace-unsaid] 2026-09-25: что остаётся после решения оператора', () => {
  it('проба механизма: реестр следов собран из реестра обязательных действий и непуст', () => {
    expect(AUDITED_OPERATOR_ACTIONS.length).toBe(14);
    expect(OPERATOR_TRACES.length).toBe(AUDITED_OPERATOR_ACTIONS.length);
    expect(OPERATOR_TRACES.map((t) => t.action)).toEqual([...AUDITED_OPERATOR_ACTIONS]);
    expect(OPERATOR_TRACE_ALWAYS.length).toBeGreaterThan(80);
    // Через ту же машинерию, что и остальные проверки файла: проба,
    // трогающая другое выражение, зеленеет, когда ломается это.
    expect(traceOf('library_entry.moderated').action).toBe('library_entry.moderated');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пять действий, которые писались в журнал, но правилом не назывались', () => {
    // Обнаружилось, когда экран оператора стал спрашивать у реестра, что
    // после его действий остаётся: снятие ограничения и разблокировка —
    // такие же решения о человеке, как их наложение; заморозка и
    // разморозка — решения о его работе; открытие карточки — доступ к его
    // словам.
    for (const action of [
      'user.unrestricted',
      'user.unblocked',
      'project.frozen',
      'project.unfrozen',
      'admin.project_card.viewed',
    ]) {
      expect(AUDITED_OPERATOR_ACTIONS).toContain(action);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «увидит ли человек» считается из области журнала, а не из второй копии', () => {
    const inScope = new Set(DECISION_SCOPES.map((s) => s.resource));
    let checked = 0;
    for (const t of OPERATOR_TRACES) {
      expect(t.visibleToPerson).toBe(inScope.has(DECISION_RESOURCE[t.action]));
      checked += 1;
    }
    expect(checked).toBe(14);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: на одном экране заведений след у действий РАЗНЫЙ', () => {
    // Подписью «пишется в журнал» это не передать: решение по заявке
    // человек увидит (заявка — его запись), а признак партнёра и
    // вознаграждение — нет (запись принадлежит заведению).
    expect(traceOf('venue_application.approved').visibleToPerson).toBe(true);
    expect(traceOf('venue_application.rejected').visibleToPerson).toBe(true);
    expect(traceOf('approved_venue.priority_partner_set').visibleToPerson).toBe(false);
    expect(traceOf('approved_venue.referral_fee_set').visibleToPerson).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: где не видно — сказано ПОЧЕМУ, теми же словами, что в реестре невходящего', () => {
    const named = new Map(DECISIONS_OUT_OF_SCOPE.map((s) => [s.resource, s.why]));
    let checked = 0;
    for (const t of OPERATOR_TRACES) {
      if (t.visibleToPerson) {
        expect(t.whyNotVisible).toBeNull();
        continue;
      }
      expect(t.whyNotVisible).toBe(named.get(DECISION_RESOURCE[t.action]));
      expect((t.whyNotVisible ?? '').length).toBeGreaterThan(60);
      checked += 1;
    }
    // Невидимых человеку среди обязательных к следу действительно есть —
    // иначе предыдущая проверка прошла бы впустую.
    expect(checked).toBeGreaterThan(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр не называет действий, которых в продукте нет', () => {
    // Здесь числилось `admin_domain.updated` — ни одного вызова `record`
    // с таким именем и ни одного эндпоинта, который его писал бы. Реестр
    // «обязаны оставлять след» выглядел полнее, чем есть: тот же дефект,
    // что продукт чинит снаружи, направленный внутрь. Проверка ловит
    // следующего такого призрака: у обязательного действия обязаны быть
    // и подпись человеку, и вид записи журнала.
    const phantom = AUDITED_OPERATOR_ACTIONS.filter(
      (a) => !(a in DECISION_LABELS) || !(a in DECISION_RESOURCE),
    );
    expect(phantom).toEqual([]);
    expect(AUDITED_OPERATOR_ACTIONS).not.toContain('admin_domain.updated');
  });

  it('след несёт ту же фразу, что прочитает человек, — а не свою', () => {
    for (const t of OPERATOR_TRACES) {
      const label = DECISION_LABELS[t.action];
      if (label) expect(t.what).toBe(label.what);
    }
  });

  it('обратная проба: у нерасшифрованного действия подпись не выдумывается', () => {
    const unknown = traceOf('something.never.seen');
    expect(unknown.what).toMatch(/не расшифровано/);
    expect(unknown.visibleToPerson).toBe(false);
    expect(unknown.whyNotVisible).toMatch(/не описан/);
    expect(unknown.resource).toBe('не описан');
  });

  it('оператору сказано, что его заметку человек НЕ прочитает', () => {
    // Иначе оператор напишет рабочую формулировку так, будто её читает
    // человек, — и ошибётся адресатом (правило пункта [audit-trail]).
    expect(OPERATOR_TRACE_ALWAYS).toMatch(/заметка[^.]*не показывается/i);
    expect(OPERATOR_TRACE_ALWAYS).toMatch(/не редактируется и не удаляется/);
  });
});
