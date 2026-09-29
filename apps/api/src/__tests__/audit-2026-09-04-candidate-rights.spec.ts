// Сверка прав кандидата 2026-09-04 — право, которое продукт обещал и не
// давал.
//
// Заход про то, что продукт показывает НЕ СВОИМ пользователям. Шесть
// публичных страниц; самая нагруженная — преданкета кандидата. Кандидат
// единственный участник, который продукт не выбирал: ссылку ему
// прислали, аккаунта у него нет, и спросить ему некого.
//
// НАЙДЕНО. Текст согласия говорил ему дословно: «вы можете ПОПРОСИТЬ
// отозвать согласие». Отзыв в продукте существовал — и хороший:
// `POST /candidate-profiles/:id/revoke-consent` помечает профиль и гасит
// живые ссылки, которыми его передали дальше. Но доступен он был ТОЛЬКО
// РЕКРУТЕРУ, за авторизацией. У кандидата не было ничего: «попросить»
// было некого, кроме того самого человека, от чьих действий он и хотел
// бы отгородиться. Обещанное право без способа им воспользоваться.
//
// ЧТО СДЕЛАНО. Тот же отзыв — по тому же токену, что и анкета. Никакой
// новой колонки: первая версия правки заводила отметку на приглашении и
// ручную миграцию к ней, и это было лишним — механизм в продукте уже
// был, не хватало ДОСТУПА К НЕМУ. Переиспользование дало и полный
// эффект, и работоспособность сразу, без ожидания владельца.
//
// И ОБЯЗАТЕЛЬНАЯ ВТОРАЯ ПОЛОВИНА: что отзыв НЕ делает. Ответы, которые
// человек уже прочитал, не стираются — часть могла стать его рабочими
// записями. «Отозвано» без перечня последствий читается как «стёрлось
// всё», а неправда в тексте о правах хуже отсутствия текста.
//
// СОСЕДНЯЯ НАХОДКА, без кода: экран приёма чужого профиля («Профиль
// кандидата») не говорил принимающему НИЧЕГО об основании — при том что
// соседняя ветка того же экрана (самошеринг соискателя) называет его
// прямо. Правило в продукте было, просто не везде, и молчало оно там,
// где данные пересекают границу организации.

import { HiringExtrasService, CANDIDATE_REVOCATION_EFFECTS } from '../hiring-extras/hiring-extras.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

function setup() {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(() => '{}');
  const audit = { records: [] as any[], record: async (r: any) => { audit.records.push(r); return r; } };
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const extras = new HiringExtrasService(prisma as any, router as any, audit as any, sheets, matching);

  const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
  const profile = prisma.seed('candidateProfile', { displayName: 'Иван', ownerUserId: 'u1', consentRevokedAt: null });
  const status = prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
  const invite = prisma.seed('preQuestionnaireInvite', {
    pipelineStatusId: status.id,
    token: 'tok-123',
    expiresAt: new Date(Date.now() + 86_400_000),
    answeredAt: new Date(),
    aiNoticeAcceptedAt: new Date(),
    transferConsentAcceptedAt: new Date(),
  });
  return { prisma, audit, extras, project, profile, status, invite };
}

describe('Права кандидата: обещанное право должно быть выполнимым', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: кандидат отзывает согласие сам, по своему токену — без аккаунта', async () => {
    const s = setup();
    const res = await s.extras.revokePreQuestionnaireConsent('tok-123');
    expect(res.alreadyRevoked).toBe(false);
    expect(res.consentRevokedAt).toBeInstanceOf(Date);
    // Отзыв реальный, а не отметка в стороне: он пользуется тем же
    // механизмом, что и рекрутерский маршрут.
    expect(s.prisma.rows('candidateProfile')[0].consentRevokedAt).toBeTruthy();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отзыв гасит живые ссылки, которыми профиль передали дальше', async () => {
    // Отзыв, не закрывающий уже отправленную ссылку, — это не отзыв.
    const s = setup();
    s.prisma.seed('candidateShare', { sourceCandidateId: s.profile.id, shareToken: 'sh-1', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null });
    s.prisma.seed('candidateShare', { sourceCandidateId: s.profile.id, shareToken: 'sh-2', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null });
    const res = await s.extras.revokePreQuestionnaireConsent('tok-123');
    expect(res.sharesRevoked).toBe(2);
    expect(s.prisma.rows('candidateShare').every((x: any) => x.revokedAt)).toBe(true);
    // Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25: текст,
    // который прочитает кандидат, СТРОИТСЯ из исхода. Раньше к
    // посчитанным числам приклеивалась фиксированная фраза — одна и та
    // же при двух закрытых ссылках и при нуле.
    expect(res.alsoDone).toContain('2 ссылки');
  });

  it('КЛЮЧЕВОЙ ТЕСТ [the-sentence-did-not-look-at-the-fact]: закрывать было нечего — так и сказано, а не «закрыто»', async () => {
    // Обратная сторона: фраза о проделанной работе при нулевом исходе
    // читается как сделанная работа. «Нечего было закрывать» — другая
    // новость, и для человека она честнее.
    const s = setup();
    const res = await s.extras.revokePreQuestionnaireConsent('tok-123');
    expect(res.sharesRevoked).toBe(0);
    expect(res.alsoDone).toContain('не было');
    expect(res.alsoDone).not.toMatch(/закрыто \d/);
  });

  // ── Пункт [copy-outlived-consent] 2026-09-24 ──
  //
  // Этот маршрут — единственный из трёх, где действует САМ КАНДИДАТ, без
  // посредника. И он повторял код рекрутерского маршрута вместе с его
  // изъяном: копия, уже принятая другой стороной в свой проект,
  // оставалась в работе. Отзыв, не догоняющий копию, — это не отзыв, по
  // той же логике, что и в тесте выше про ссылки.
  it('КЛЮЧЕВОЙ ТЕСТ [copy-outlived-consent]: отзыв самим кандидатом догоняет принятые копии', async () => {
    const s = setup();
    const copy1 = s.prisma.seed('candidateProfile', { ownerUserId: 'агентство', displayName: 'Копия' });
    const copy2 = s.prisma.seed('candidateProfile', { ownerUserId: 'работодатель', displayName: 'Копия копии' });
    s.prisma.seed('candidateShare', { sourceCandidateId: s.profile.id, createdCandidateProfileId: copy1.id, shareToken: 'sh-a', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null });
    s.prisma.seed('candidateShare', { sourceCandidateId: copy1.id, createdCandidateProfileId: copy2.id, shareToken: 'sh-b', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null });

    const res = await s.extras.revokePreQuestionnaireConsent('tok-123');

    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy1.id)!.consentRevokedAt).toBeTruthy();
    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy2.id)!.consentRevokedAt).toBeTruthy();
    expect(res.copiesRevoked).toBe(2);
    expect(res.depthExhausted).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ответ называет и что отзыв сделал, и чего НЕ сделал', () => {
    // «Отозвано» без перечня последствий человек достраивает в свою
    // пользу и решает, что стёрлось всё. Обещать это было бы неправдой:
    // ответы уже прочитал человек.
    expect(CANDIDATE_REVOCATION_EFFECTS.alsoDone).toMatch(/помечен|закрыт/i);
    expect(CANDIDATE_REVOCATION_EFFECTS.doesNotUndo).toMatch(/останутся|не стирает/i);
    // И прямо сказано, куда идти за полным удалением: право без адреса —
    // это снова обещание без способа им воспользоваться.
    expect(CANDIDATE_REVOCATION_EFFECTS.doesNotUndo).toMatch(/удаление/i);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: повторный отзыв — не ошибка, и второй записи в журнале нет', async () => {
    // Кандидат мог закрыть страницу и открыть ссылку снова. Ошибка в
    // ответ на попытку воспользоваться своим правом читается как отказ.
    const s = setup();
    await s.extras.revokePreQuestionnaireConsent('tok-123');
    const again = await s.extras.revokePreQuestionnaireConsent('tok-123');
    expect(again.alreadyRevoked).toBe(true);
    expect(s.audit.records.filter((r) => r.action === 'candidate_consent.revoked_by_candidate')).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: в журнале отзыв кандидата и отзыв рекрутера — РАЗНЫЕ события', async () => {
    // «Кандидат попросил, и я записал» и «кандидат отозвал сам» — разные
    // факты; сложить их одним именем значит потерять, кто действовал.
    const s = setup();
    await s.extras.revokePreQuestionnaireConsent('tok-123');
    const rec = s.audit.records.find((r) => r.action === 'candidate_consent.revoked_by_candidate');
    expect(rec).toBeTruthy();
    expect(rec.action).not.toBe('candidate_consent.revoked_by_recruiter');
    expect(rec.after).toMatchObject({ viaInviteId: s.invite.id });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: анкета сообщает состояние отзыва — и текст согласия больше не обещает лишнего', async () => {
    const s = setup();
    const before = await s.extras.preQuestionnaireForm('tok-123');
    expect(before.consentRevokedAt).toBeNull();
    // Формулировка права должна соответствовать тому, что продукт даёт.
    expect(before.consents.transfer).not.toMatch(/попросить отозвать/);
    expect(before.consents.transfer).toMatch(/отозвать согласие можно здесь же/);

    await s.extras.revokePreQuestionnaireConsent('tok-123');
    const after = await s.extras.preQuestionnaireForm('tok-123');
    expect(after.consentRevokedAt).toBeTruthy();
  });

  it('просроченная ссылка отзыв не принимает — как и всё остальное по ней', async () => {
    const s = setup();
    s.prisma.rows('preQuestionnaireInvite')[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.extras.revokePreQuestionnaireConsent('tok-123')).rejects.toThrow(/недействительна|просрочена/);
  });
});
