// Пункт [door-opened-onto-a-corner] 2026-09-25 — поправка к собственной
// предыдущей сверке.
//
// Пункт [right-with-no-door] вывел решения на экран и отбирал их по двум
// видам записи. Реестр подписей к тому моменту знал 34 действия — экран
// дотягивался до девяти. Здесь проверяется ПОЛНОТА ОБЛАСТИ: каждое
// расшифрованное действие, сделанное НЕ САМИМ человеком, обязано либо
// попадать в область, либо быть названным невходящим с причиной.

import { DECISION_LABELS } from '../privacy-center/decision-labels';
import {
  DECISION_RESOURCE as RESOURCE_OF,
  DECISION_SCOPES,
  DECISIONS_OUT_OF_SCOPE,
  ownScopeIds,
} from '../privacy-center/decision-scope';

// Карта видов переехала в production (пункт
// [operator-left-a-trace-unsaid] 2026-09-25): по ней считается, увидит ли
// человек решение оператора, и этот ответ нужен экрану, а не только
// проверке. Её полнота по-прежнему проверяется здесь.


describe('Пункт [door-opened-onto-a-corner] 2026-09-25: область журнала решений', () => {
  it('проба механизма: реестры и карта видов прочитаны непустыми', () => {
    // Проба трогает ту же машинерию, что и ключевые тесты, — в том числе
    // локальную карту `RESOURCE_OF`. Сторож [probe-checked-the-neighbour]
    // справедливо забраковал первую версию: она смотрела только на
    // импортированные реестры, то есть на соседнее выражение.
    // 2026-09-30: стало 36 — прибавились два счётчика расхода
    // (обращения к картам и проверки фото). Содержимого в этих
    // записях нет, но в журнале человека они видны, и подпись им
    // обязательна.
    expect(Object.keys(DECISION_LABELS).length).toBe(36);
    expect(Object.keys(RESOURCE_OF).length).toBe(36);
    expect(DECISION_SCOPES.length).toBe(10);
    expect(DECISIONS_OUT_OF_SCOPE.length).toBe(5);
  });

  it('у каждого расшифрованного действия назван вид записи в журнале', () => {
    const unmapped = Object.keys(DECISION_LABELS).filter((a) => !(a in RESOURCE_OF));
    expect(unmapped).toEqual([]);
    const stale = Object.keys(RESOURCE_OF).filter((a) => !(a in DECISION_LABELS));
    expect(stale).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: решение, сделанное НЕ самим человеком, либо в области, либо названо невходящим', () => {
    const inScope = new Set(DECISION_SCOPES.map((s) => s.resource));
    const named = new Set(DECISIONS_OUT_OF_SCOPE.map((s) => s.resource));
    const silent: string[] = [];
    let checked = 0;
    for (const [action, label] of Object.entries(DECISION_LABELS)) {
      if (label.by === 'вы сами') continue; // собственное действие — не решение о человеке
      checked += 1;
      const resource = RESOURCE_OF[action];
      if (!inScope.has(resource) && !named.has(resource)) silent.push(`${action} (${resource})`);
    }
    // Число фиксируется: молча опустевший реестр подписей прошёл бы цикл
    // насквозь, ничего не проверив.
    expect(checked).toBe(29);
    expect(silent).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: область покрывает то, что раньше не доходило до человека', () => {
    const inScope = new Set(DECISION_SCOPES.map((s) => s.resource));
    // Именно эти решения человек прежде не видел нигде: его заявку
    // рассмотрели, согласие на передачу его данных отозвали, оффер ему
    // отозвали, принятую ссылку отозвали.
    for (const action of [
      'library_entry.moderated',
      'venue_application.rejected',
      'candidate_consent.revoked_by_recruiter',
      'candidate_pipeline_status.stage_changed',
      'offer.withdrawn',
      'candidate_self_share.accepted',
      'engagement.revoked',
      'status_letter.marked_sent_by_recruiter',
    ]) {
      expect(inScope.has(RESOURCE_OF[action])).toBe(true);
    }
  });

  it('каждое невходящее названо причиной, а не отметкой', () => {
    for (const s of DECISIONS_OUT_OF_SCOPE) {
      expect(s.why.length).toBeGreaterThan(60);
      expect(s.resource.length).toBeGreaterThan(0);
    }
    // И ни один вид не может одновременно входить и не входить.
    const inScope = new Set(DECISION_SCOPES.map((s) => s.resource));
    expect(DECISIONS_OUT_OF_SCOPE.filter((s) => inScope.has(s.resource))).toEqual([]);
  });

  it('у каждой области записан довод, зачем она решение О ЧЕЛОВЕКЕ', () => {
    for (const s of DECISION_SCOPES) {
      expect(s.why.length).toBeGreaterThan(30);
      expect(['account', 'project', 'belongings']).toContain(s.group);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждая область ищет записи ИМЕННО ЭТОГО человека', async () => {
    // Мутация «убрать условие владения у одной области» пережила первую
    // версию проверок, а означает она худшее из возможного: человек
    // увидел бы решения о ЧУЖИХ записях как решения о своих. Проверяется
    // каждая область сразу, а не выбранные.
    const seen: Array<{ resource: string; where: unknown }> = [];
    let checked = 0;
    for (const scope of DECISION_SCOPES) {
      if (scope.resource === 'User') continue; // единственная область без запроса: сам человек
      const prisma: any = new Proxy(
        {},
        {
          get: () => ({
            findMany: (args: any) => {
              seen.push({ resource: scope.resource, where: args.where });
              return Promise.resolve([]);
            },
          }),
        },
      );
      await scope.ownIds(prisma, 'u-СВОЙ');
      checked += 1;
    }
    expect(checked).toBe(9);
    expect(seen.length).toBe(9);
    for (const { resource, where } of seen) {
      // Вид записи в сообщении: без него отчёт о сбое не говорит, У КАКОЙ
      // области условие владения потерялось.
      expect(`${resource}: ${JSON.stringify(where)}`).toContain('u-СВОЙ');
    }
    // Обратная проба: та же машинерия на пустом условии поймала бы
    // подмену — проверка не проходит просто от того, что что-то вызвано.
    expect(seen.every((x) => JSON.stringify(x.where) !== '{}')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: вид без единой записи человека в условие не попадает', async () => {
    // `OR: []` в Prisma не сужает НИЧЕГО — пустое условие отдало бы весь
    // журнал, то есть чужие решения. Виды с пустым списком отбрасываются.
    const prisma: any = {
      project: { findMany: async () => [] },
      libraryEntry: { findMany: async () => [{ id: 'lib-1' }] },
      venueApplication: { findMany: async () => [] },
      candidateProfile: { findMany: async () => [] },
      candidatePipelineStatus: { findMany: async () => [] },
      candidateShare: { findMany: async () => [{ id: 'sh-1' }] },
      termsSheet: { findMany: async () => [] },
      offerDocument: { findMany: async () => [] },
      employerAgencyEngagement: { findMany: async () => [] },
    };
    const where = await ownScopeIds(prisma, 'u-1', 'belongings');
    expect(where.map((w) => w.resource)).toEqual(['LibraryEntry', 'CandidateShare']);
    expect(where.every((w) => w.resourceId.in.length > 0)).toBe(true);

    // Обратная проба: аккаунт всегда даёт ровно одну запись — самого
    // человека, и запрос по нему никогда не пустой.
    const account = await ownScopeIds(prisma, 'u-1', 'account');
    expect(account).toEqual([{ resource: 'User', resourceId: { in: ['u-1'] } }]);
  });
});
