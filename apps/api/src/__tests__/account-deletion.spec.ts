// Аудит моделей БД 2026-08-30 §2.4 — удаление аккаунта (GDPR art. 17).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrivacyCenterService } from '../privacy-center/privacy-center.service';

import type { ExternalArtifactsReport as Report } from '../common/external-artifacts/external-artifacts-cleanup.service';
import { ACCOUNT_NOT_REMOVED_HERE } from '../privacy-center/deletion-report';

// Уборка внешних артефактов вынесена в ExternalArtifactsCleanupService
// (аудит 2026-09-02, продолжение) и покрыта своей спекой; здесь она —
// фейк с настраиваемым отчётом. Проверяется порядок: артефакты → аудит →
// user.delete, и что отчёт доезжает до ответа и журнала.
function make(opts: { report?: Partial<Report>; user?: any; aiJobs?: any[]; failScrub?: boolean; losses?: Record<string, number> } = {}) {
  const calls: any = { deleted: [] as string[], audit: [] as any[], cleanupFor: [] as string[], aiUpdates: [] as any[], inferencesDeletedFor: [] as string[][], auditScrubFor: [] as string[], lossCounts: [] as number[] };
  const aiJobs = opts.aiJobs ?? [];
  const prisma: any = {
    // Сверка «половины операции» 2026-09-04: стирание следов AI идёт
    // одной транзакцией. Фейк выполняет колбэк на себе — отката у него
    // нет, и притворяться, что есть, было бы хуже: сам инвариант держит
    // audit-2026-09-04-atomicity.service.spec.ts.
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
    user: {
      findUnique: async () => opts.user === undefined ? { id: 'u1', telegramId: '123456' } : opts.user,
      delete: async ({ where }: any) => { calls.deleted.push(where.id); return {}; },
    },
    // Аудит 2026-09-02 (продолжение): следы AI-вызовов после каскада.
    aIJob: {
      findMany: async ({ where }: any) => aiJobs.filter((j) => j.requestUserId === where.requestUserId).map((j) => ({ id: j.id })),
      updateMany: async ({ where, data }: any) => {
        const hit = aiJobs.filter((j) => where.id.in.includes(j.id)
          && (!where.status || (where.status.in ? where.status.in.includes(j.status) : where.status.not ? j.status !== where.status.not : true)));
        for (const j of hit) Object.assign(j, data);
        calls.aiUpdates.push({ where, data });
        return { count: hit.length };
      },
    },
    aIInference: {
      deleteMany: async ({ where }: any) => {
        if (opts.failScrub) throw new Error('db failure while scrubbing');
        calls.inferencesDeletedFor.push(where.aiJobId.in);
        return { count: where.aiJobId.in.length * 2 };
      },
    },
    project: { count: async () => 3 }, conversation: { count: async () => 5 }, person: { count: async () => 2 },
    consentRecord: { count: async () => 4 }, intakeSession: { count: async () => 1 }, mediaReviewQueue: { count: async () => 0 },
    // Пункт [cascade-took-a-stranger] 2026-09-26: удаление считает ДО
    // каскада, что заберёт у других. Здесь эти числа нулевые — сами они
    // проверяются своей спекой, эта про порядок шагов.
    libraryExperience: { count: async () => { calls.lossCounts.push(calls.deleted.length); return opts.losses?.libraryExperience ?? 0; } },
    libraryEntry: { count: async () => opts.losses?.libraryEntry ?? 0 },
    venueBookingConfirmation: { count: async () => opts.losses?.venueBookingConfirmation ?? 0 },
    approvedVenue: { count: async () => 0 },
    publicComment: { count: async () => opts.losses?.publicComment ?? 0 },
    publicArgumentSubmission: { count: async () => 0 },
  };
  // Пункт [audit-trail] 2026-09-04: удаление аккаунта теперь ещё и
  // вычищает свободный текст из записей журнала — фейк повторяет обе
  // половины, чтобы порядок шагов проверялся целиком.
  const audit = {
    record: async (r: any) => { calls.audit.push(r); },
    scrubFreeTextForDeletedUser: async (userId: string) => {
      calls.auditScrubFor.push(userId);
      return { auditEntriesScrubbed: 2 };
    },
  };
  const report: Report = {
    evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0,
    conversationAudioBlobs: 0, conversationAudioDeleted: 0, conversationAudioFailed: 0,
    sttJobsInFlight: 0, sttJobsDiscarded: 0, sttJobsFailed: 0,
    ...opts.report,
  };
  const cleanup = { discardForUser: async (userId: string) => { calls.cleanupFor.push(userId); return report; } };
  return { svc: new PrivacyCenterService(prisma, audit as any, cleanup as any), calls };
}

describe('deleteAccount', () => {
  it('без confirmation="DELETE" — BadRequest, ничего не удаляется', async () => {
    const { svc, calls } = make();
    await expect(svc.deleteAccount('u1', 'yes')).rejects.toThrow(BadRequestException);
    expect(calls.deleted).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('несуществующий пользователь — NotFound', async () => {
    const { svc } = make({ user: null });
    await expect(svc.deleteAccount('u1', 'DELETE')).rejects.toThrow(NotFoundException);
  });

  it('порядок: blob → аудит (без telegramId, с хешем и счётчиками) → user.delete; отчёт о внешних артефактах', async () => {
    const { svc, calls } = make({ report: { evidenceBlobs: 2, evidenceDeleted: 1, evidenceFailed: 1 } });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(calls.deleted).toEqual(['u1']);
    expect(calls.audit).toHaveLength(1);
    const rec = calls.audit[0];
    expect(rec.action).toBe('user.deleted');
    expect(rec.actorId).toBeNull();
    expect(JSON.stringify(rec)).not.toContain('123456');
    expect(rec.before.telegramIdHash).toHaveLength(16);
    expect(rec.before).toMatchObject({ projects: 3, conversations: 5, evidenceBlobs: 2 });
    expect(res.externalArtifacts).toMatchObject({ evidenceBlobs: 2, deleted: 1, failed: 1 });
    expect(calls.cleanupFor).toEqual(['u1']);
    expect(res.deleted).toBe(true);
    // Пункт [screen-said-what-server-unsaid] 2026-09-25: «непустой» —
    // слишком слабо. Дефект пункта в том, что две копии этого текста
    // РАЗОШЛИСЬ; значит проверять надо совпадение с единственным
    // источником, а не наличие хоть чего-нибудь.
    expect(res.notRemovedHere).toEqual([...ACCOUNT_NOT_REMOVED_HERE]);
  });

  it('РЕГРЕССИЯ (аудит 2026-09-02): отчёт об аудио разговоров и задачах распознавания в полёте доезжает до ответа и журнала аудита', async () => {
    // Пункт [discarded-nothing-said-three] 2026-09-30: числа НАРОЧНО
    // разные. Прежде в `before` как «задач в полёте» уходило число
    // отозванных — то же самое поле, — а в `after` оно же как
    // «отозвано»: одно число изображало два.
    const { svc, calls } = make({
      report: {
        conversationAudioBlobs: 2, conversationAudioDeleted: 1, conversationAudioFailed: 1,
        sttJobsInFlight: 3, sttJobsDiscarded: 1, sttJobsFailed: 2,
      },
    });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.externalArtifacts).toMatchObject({
      conversationAudioBlobs: 2, conversationAudioDeleted: 1, conversationAudioFailed: 1,
      sttJobsInFlight: 3, sttJobsDiscarded: 1, sttJobsFailed: 2,
    });
    expect(calls.audit[0].before).toMatchObject({ conversationAudioBlobs: 2, sttJobsInFlight: 3 });
    expect(calls.audit[0].after).toMatchObject({ sttJobsDiscarded: 1, sttJobsFailed: 2, conversationAudioFailed: 1 });
    expect(calls.deleted).toEqual(['u1']);
  });

  it('РЕГРЕССИЯ (аудит 2026-09-02): после каскада выводы AI удаляются, неисполненные джобы отменяются, тексты запросов обнуляются — строки джоб остаются для телеметрии', async () => {
    const aiJobs = [
      { id: 'j-done', requestUserId: 'u1', status: 'COMPLETED', pendingRequest: null, partialResult: 'обрывок' },
      { id: 'j-queued', requestUserId: 'u1', status: 'QUEUED', pendingRequest: { userPrompt: 'моя ситуация целиком' }, partialResult: null },
      { id: 'j-other', requestUserId: 'u2', status: 'QUEUED', pendingRequest: { userPrompt: 'чужое' }, partialResult: null },
    ];
    const { svc, calls } = make({ aiJobs });
    const res = await svc.deleteAccount('u1', 'DELETE');
    // requestUserId — не FK: до правки всё это оставалось в ai_jobs /
    // ai_inferences после удаления аккаунта.
    expect(calls.inferencesDeletedFor).toEqual([['j-done', 'j-queued']]);
    expect(aiJobs[1]).toMatchObject({ status: 'CANCELLED' });
    expect(aiJobs[1].pendingRequest).not.toEqual({ userPrompt: 'моя ситуация целиком' });
    expect(aiJobs[0].partialResult).toBeNull();
    expect(aiJobs[2]).toMatchObject({ status: 'QUEUED', pendingRequest: { userPrompt: 'чужое' } }); // чужие джобы не тронуты
    expect(res.removed).toMatchObject({ aiInferences: 4, aiJobsCancelled: 1 });
    // Следы AI чистятся ПОСЛЕ каскада: ссылки на инференсы из сущностей
    // пользователя к этому моменту уже сняты.
    expect(calls.deleted).toEqual(['u1']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (сверка «половины операции» 2026-09-04): недоделанное стирание следов AI попадает в аудит, а не исчезает молча', async () => {
    // Аккаунт к этому моменту уже удалён каскадом: пожаловаться на
    // недоделанное удаление некому и неоткуда. Единственный, кто может
    // это увидеть, — оператор в журнале, поэтому остаток обязан быть там
    // назван поимённо (какие джобы), а вызов — упасть, а не отчитаться
    // об успехе.
    const aiJobs = [{ id: 'j-1', requestUserId: 'u1', status: 'QUEUED', pendingRequest: { userPrompt: 'моя ситуация целиком' } }];
    const { svc, calls } = make({ aiJobs, failScrub: true });

    await expect(svc.deleteAccount('u1', 'DELETE')).rejects.toThrow(/db failure while scrubbing/);
    const failure = calls.audit.find((r: any) => r.action === 'user.deleted.ai_scrub_failed');
    expect(failure).toBeDefined();
    expect(failure.after.jobIds).toEqual(['j-1']);
    // И в самой записи аудита нет текста человека — только идентификаторы.
    expect(JSON.stringify(failure)).not.toContain('моя ситуация целиком');
  });

  it('КЛЮЧЕВОЙ ТЕСТ [cascade-took-a-stranger]: отчёт называет, что удаление забрало у ДРУГИХ', async () => {
    // Каскад уносит рассказы других людей под разборами в библиотеке,
    // отметки о бронировании в заведении и комментарии приглашённых.
    // Молчание об этом читалось бы как «ни у кого ничего».
    const { svc, calls } = make({ losses: { libraryExperience: 2, venueBookingConfirmation: 4, publicComment: 7 } });
    const res = await svc.deleteAccount('u1', 'DELETE');

    expect(res.tookFromOthers.map((l: any) => l.key)).toEqual([
      'library-experiences',
      'venue-bookings',
      'discussion-comments',
    ]);
    expect(res.tookFromOthers.map((l: any) => l.count)).toEqual([2, 4, 7]);
    expect(res.tookFromOthersNote).toMatch(/не ваши данные/i);

    // И числа сняты ДО каскада: после него считать нечего.
    expect(calls.lossCounts).toEqual([0]); // на момент подсчёта удалений ещё не было
    expect(calls.deleted).toEqual(['u1']);
  });

  it('обратная проба [cascade-took-a-stranger]: чужого нет — список пуст, а не строки с нулями', async () => {
    const { svc } = make();
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.tookFromOthers).toEqual([]);
  });

  it('файлы, которые не удалились (нет токена Blob и т. п.), помечаются failed — аккаунт всё равно удаляется', async () => {
    const { svc, calls } = make({ report: { evidenceBlobs: 1, evidenceDeleted: 0, evidenceFailed: 1 } });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.externalArtifacts).toMatchObject({ evidenceBlobs: 1, deleted: 0, failed: 1 });
    expect(calls.deleted).toEqual(['u1']);
  });
});
