// Аудит заморозки 2026-09-03 — три действия, которых guard не видит.
//
// `ProjectFrozenGuard` находит проект по URL и покрывает 151 мутирующий
// маршрут из 154. Оставшиеся три — принятие по токену (проект-получатель в
// теле запроса) и передача копии второй стороне (её проект вычисляется из
// шеринга): guard про них не узнает никогда, это граница самого приёма, а
// не пробел таблицы. Тесты держат правило «в замороженный проект не пишет
// никто» и разницу формулировок: своему — с причиной, чужому — нейтрально.
import { ProjectMode, TermsSheetKind } from '@prisma/client';
import { CandidateSelfShareService } from '../candidate-self-share/candidate-self-share.service';
import { OfferExchangeService } from '../employer-hiring/offer-exchange.service';
import { EngagementService } from '../employer-hiring/engagement.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { HiringExtrasService } from '../hiring-extras/hiring-extras.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

function setup() {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(() => '{}');
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const selfShare = new CandidateSelfShareService(prisma as any, fakeAudit as any, sheets);
  const engagements = new EngagementService(prisma as any, fakeAudit as any);
  const extras = new HiringExtrasService(prisma as any, router as any, fakeAudit as any, sheets, matching);
  return { prisma, sheets, selfShare, engagements, extras };
}

describe('Заморозка: в замороженный проект не пишет никто', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: принять самошеринг кандидата в свой замороженный проект нельзя — и человеку названа причина', async () => {
    const s = setup();
    // Соискатель поделился собой.
    const candidateUser = 'кандидат';
    const jobProject = s.prisma.seed('project', { ownerId: candidateUser, mode: ProjectMode.JOB_SEARCH, frozenAt: null });
    s.prisma.seed('jobSearchConfig', { projectId: jobProject.id, desiredRole: 'Backend', cvDraft: null });
    const share = s.prisma.seed('candidateShare', {
      sharedByUserId: candidateUser,
      shareToken: 'tok-1',
      consentSource: 'CANDIDATE_SELF',
      consentTextVersion: 'v3',
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
      revokedAt: null,
      sourceSheetId: null,
      sourceCandidateId: null,
      visibleClauseIds: [],
    });

    // Получатель — агентство, чей проект оператор заморозил.
    const pool = s.prisma.seed('project', {
      ownerId: 'агентство',
      mode: ProjectMode.INTERVIEW_POOL,
      recruitingTeamId: null,
      frozenAt: new Date(),
      frozenNote: 'разбор жалобы',
    });
    s.prisma.seed('interviewPoolConfig', { projectId: pool.id, jobTitle: 'Backend' });

    await expect(s.selfShare.accept('агентство', { token: share.shareToken, projectId: pool.id })).rejects.toThrow(/заморожен оператором/);
    // Ничего не создано: ни профиля кандидата, ни строки пайплайна.
    expect(s.prisma.rows('candidateProfile')).toHaveLength(0);
    expect(s.prisma.rows('candidatePipelineStatus')).toHaveLength(0);
    // И сам шеринг не помечен принятым — иначе ссылка сгорела бы впустую.
    expect(s.prisma.rows('candidateShare')[0].acceptedAt).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ (сверка мест применения 2026-09-04): агентство не примет заказ в СВОЙ замороженный пул — и причину узнаёт', async () => {
    // Вторая половина того же правила: чужому проекту отказ нейтральный,
    // своему — с причиной и заметкой оператора. Тест на первую половину
    // был, на эту — нет: мутационная сверка показала, что вызов
    // `assertProjectNotFrozen()` в этой ветке удаляется незаметно.
    const s = setup();
    const employerProject = s.prisma.seed('project', { ownerId: 'работодатель', mode: ProjectMode.EMPLOYER_HIRING, frozenAt: null });
    const team = s.prisma.seed('recruitingTeam', { name: 'Агентство', teamType: 'AGENCY' });
    s.prisma.seed('recruitingTeamMember', { teamId: team.id, userId: 'агент', role: 'OWNER' });
    const agencyPool = s.prisma.seed('project', {
      ownerId: 'агент',
      mode: ProjectMode.INTERVIEW_POOL,
      recruitingTeamId: team.id,
      frozenAt: new Date(),
      frozenNote: 'разбор жалобы кандидата',
    });
    const engagement = s.prisma.seed('employerAgencyEngagement', {
      employerProjectId: employerProject.id,
      token: 'inv-2',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 86_400_000),
      sharedItems: [],
      agencyProjectId: null,
      agencyTeamId: null,
      acceptedAt: null,
    });

    const err = await s.engagements
      .accept('агент', { token: engagement.token, teamId: team.id, agencyProjectId: agencyPool.id })
      .catch((e: any) => e);
    expect(err.getStatus()).toBe(423);
    // Свой проект — причина названа прямо, вместе с заметкой оператора.
    expect(err.getResponse().message).toMatch(/заморожен/i);
    expect(err.getResponse().message).toMatch(/разбор жалобы кандидата/);
    expect(s.prisma.rows('employerAgencyEngagement')[0].status).toBe('PENDING');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: агентство не узнаёт из отказа, что проект работодателя в модерации', async () => {
    const s = setup();
    const employerProject = s.prisma.seed('project', {
      ownerId: 'работодатель',
      mode: ProjectMode.EMPLOYER_HIRING,
      frozenAt: new Date(),
      frozenNote: 'жалоба на текст вакансии',
    });
    const team = s.prisma.seed('recruitingTeam', { name: 'Агентство', teamType: 'AGENCY' });
    s.prisma.seed('recruitingTeamMember', { teamId: team.id, userId: 'агент', role: 'OWNER' });
    const engagement = s.prisma.seed('employerAgencyEngagement', {
      employerProjectId: employerProject.id,
      token: 'inv-1',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 86_400_000),
      sharedItems: [],
      agencyProjectId: null,
      agencyTeamId: null,
      acceptedAt: null,
    });

    const err = await s.engagements.accept('агент', { token: engagement.token, teamId: team.id }).catch((e: any) => e);
    expect(err.getStatus()).toBe(423);
    const body = err.getResponse();
    // Формулировка нейтральная: ни «заморожен», ни заметки оператора.
    expect(body.message).not.toMatch(/заморожен|жалоба на текст вакансии/i);
    expect(body.message).toMatch(/не принимает изменения/);
    // Заказ остался PENDING — принятие не состоялось.
    expect(s.prisma.rows('employerAgencyEngagement')[0].status).toBe('PENDING');
  });

  it('КЛЮЧЕВОЙ ТЕСТ (аудит публичных поверхностей 2026-09-03): публичная анкета кандидата не пишет в замороженный проект', async () => {
    // Прошлая сверка заморозки перебирала маршруты С guard'ом и этот путь
    // не увидела вовсе: у публичного контроллера guard'а нет по
    // определению. Анкета при этом создаёт в проекте рекрутера разговор,
    // транскрипт и черновики позиций.
    const s = setup();
    const project = s.prisma.seed('project', { ownerId: 'агентство', mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId: null, frozenAt: new Date(), frozenNote: 'проверка' });
    const config = s.prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Backend' });
    const question = s.prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт с очередями?', isRequired: true, orderIndex: 0 });
    const profile = s.prisma.seed('candidateProfile', { ownerUserId: 'агентство', displayName: 'Анна', consentRevokedAt: null });
    const status = s.prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    s.prisma.seed('preQuestionnaireInvite', {
      pipelineStatusId: status.id,
      token: 'preq-1',
      expiresAt: new Date(Date.now() + 86_400_000),
      answeredAt: null,
    });

    const err = await s.extras
      .submitPreQuestionnaire('preq-1', { aiNoticeAccepted: true, transferConsentAccepted: true, answers: [{ questionId: question.id, text: 'Да, Kafka' }] })
      .catch((e: any) => e);
    expect(err.getStatus()).toBe(423);
    // Кандидат не узнаёт, что проект компании в модерации.
    expect(err.getResponse().message).not.toMatch(/заморожен|проверка/i);
    // И ни одной строки в чужом проекте не появилось.
    expect(s.prisma.rows('conversation')).toHaveLength(0);
    expect(s.prisma.rows('transcriptSegment')).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (сверка мест применения 2026-09-04): копия оффера не ложится в замороженный проект соискателя — обе ветки', async () => {
    // Мутационная сверка мест применения показала, что оба вызова
    // `assertCounterpartyProjectNotFrozen()` внутри `resolveCandidateSheet`
    // можно удалить, и набор останется зелёным: путь достижим только через
    // длинную цепочку `shareToCandidate`, и ни один тест по ней не ходил.
    // Между тем это запись в ЧУЖОЙ проект — тот самый случай, ради
    // которого барьер и добавлялся.
    const s = setup();
    const exchange = new OfferExchangeService(s.prisma as any, fakeAudit as any);

    // Ветка 1: у соискателя уже есть лист-отклик, его проект заморожен.
    const frozenProject = s.prisma.seed('project', { ownerId: 'соискатель', mode: ProjectMode.JOB_SEARCH, frozenAt: new Date(), frozenNote: 'проверка' });
    const responseSheet = s.prisma.seed('termsSheet', { projectId: frozenProject.id, kind: TermsSheetKind.VACANCY_RESPONSE, ownerUserId: 'соискатель' });
    const err1 = await (exchange as any)
      .resolveCandidateSheet({ sourceSheetId: responseSheet.id, sharedByUserId: 'соискатель' }, 'проект-работодателя')
      .catch((e: any) => e);
    expect(err1.getStatus()).toBe(423);
    // Работодатель не узнаёт из отказа, что проект соискателя в модерации.
    expect(err1.getResponse().message).not.toMatch(/заморожен|проверка/i);

    // Ветка 2: листа нет — копия пошла бы в проект поиска работы, он тоже
    // заморожен. Здесь раньше создавались и вакансия, и лист.
    s.prisma.seed('jobSearchConfig', { projectId: frozenProject.id, desiredRole: 'Backend', cvDraft: null });
    const err2 = await (exchange as any)
      .resolveCandidateSheet({ sourceSheetId: null, sharedByUserId: 'соискатель' }, 'проект-работодателя')
      .catch((e: any) => e);
    expect(err2.getStatus()).toBe(423);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0);
  });

  it('отзыв собственного самошеринга работает и при заморозке — это решение, а не случайность', async () => {
    // Заморозка запрещает менять проект, а не запирает человека в уже
    // сделанной передаче: отзыв доступа к своим данным обязан работать
    // всегда, иначе заморозка становится наказанием, которого никто не
    // объявлял.
    const s = setup();
    const project = s.prisma.seed('project', { ownerId: 'кандидат', mode: ProjectMode.JOB_SEARCH, frozenAt: new Date(), frozenNote: 'проверка' });
    s.prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
    const share = s.prisma.seed('candidateShare', {
      sharedByUserId: 'кандидат',
      shareToken: 'tok-2',
      consentSource: 'CANDIDATE_SELF',
      consentTextVersion: 'v3',
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
      revokedAt: null,
      sourceSheetId: null,
      sourceCandidateId: null,
      visibleClauseIds: [],
    });

    const res = await s.selfShare.revoke('кандидат', share.id);
    expect(res.revokedAt).toBeTruthy();
    expect(s.prisma.rows('candidateShare')[0].revokedAt).toBeTruthy();
  });

  // ── Пункт [copy-outlived-consent] 2026-09-24 ──
  //
  // Этот маршрут гасил копию с самого начала — и правильно, — но ровно
  // ОДНУ, прямую. Принявший копию владеет ею и может поделиться дальше;
  // копия копии оставалась в работе.
  it('КЛЮЧЕВОЙ ТЕСТ [copy-outlived-consent]: отзыв самошеринга догоняет и копию копии', async () => {
    const s = setup();
    const copy1 = s.prisma.seed('candidateProfile', { ownerUserId: 'агентство', displayName: 'Соискатель' });
    const copy2 = s.prisma.seed('candidateProfile', { ownerUserId: 'работодатель', displayName: 'Соискатель' });
    const share = s.prisma.seed('candidateShare', {
      sharedByUserId: 'кандидат', shareToken: 'tok-3', consentSource: 'CANDIDATE_SELF', consentTextVersion: 'v3',
      expiresAt: new Date(Date.now() + 86_400_000), acceptedAt: new Date(), revokedAt: null,
      sourceSheetId: null, sourceCandidateId: null, visibleClauseIds: [],
      createdCandidateProfileId: copy1.id,
    });
    s.prisma.seed('candidateShare', {
      sharedByUserId: 'агентство', shareToken: 'tok-4', consentSource: 'RECRUITER_CONFIRMED', consentTextVersion: 'v3',
      expiresAt: new Date(Date.now() + 86_400_000), acceptedAt: new Date(), revokedAt: null,
      sourceSheetId: null, sourceCandidateId: copy1.id, visibleClauseIds: [],
      createdCandidateProfileId: copy2.id,
    });

    const res = await s.selfShare.revoke('кандидат', share.id);

    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy1.id)!.consentRevokedAt).toBeInstanceOf(Date);
    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy2.id)!.consentRevokedAt).toBeInstanceOf(Date);
    expect(res.copiesRevoked).toBe(2);
    expect(res.depthExhausted).toBe(false);
  });
});
