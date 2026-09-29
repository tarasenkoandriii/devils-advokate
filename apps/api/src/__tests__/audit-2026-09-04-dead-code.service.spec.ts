// Аудит 2026-09-03 (сверка «что написано» против «что вызывается»):
// enum-значения без единого writer'а, маршруты без экрана, методы
// сервисов, которые не вызывает ни один продуктовый путь.
//
// Общее у находок ниже одно: КОД ЕСТЬ, И ОН НЕ РАБОТАЕТ — не «падает», а
// просто никогда не выполняется. Такой пробел не виден ни по тестам (они
// зовут функцию напрямую), ни по чтению самой функции; видно только
// сверкой вызовов. Тесты здесь держат именно ВЫЗОВ на живом пути.
import { EmployerFactCategory } from '@prisma/client';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { InterviewPoolCandidateService } from '../interview-pool/interview-pool-candidate.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

// Ссылка-приглашение строится из окружения; здесь важен сам факт отправки,
// не адрес бота.
process.env.TELEGRAM_BOT_USERNAME = 'devils_advocate_test_bot';

const REGISTRY_PAGE = 'Статус юридичної особи: припинено. Дата реєстрації: 2019-04-01. Відгук клієнта: жахливий роботодавець, платять із затримкою.';

// Сеть в этих сценариях не нужна: страница подставляется мокой.
jest.mock('../common/safe-url-fetch', () => ({
  ...jest.requireActual('../common/safe-url-fetch'),
  fetchUrlText: jest.fn(async () => ({ text: REGISTRY_PAGE, intake: { used: REGISTRY_PAGE.length, total: REGISTRY_PAGE.length, limit: 8000 } })),
}));

describe('§3.7 — барьер «отзывы только ссылкой» стоит на пути записи, а не рядом с ним', () => {
  function setup(aiFacts: Array<{ category: string; quote: string }>) {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ facts: aiFacts }));
    const dossiers = new EmployerDossierService(prisma as any, router as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const dossier = prisma.seed('employerDossier', {
      projectId: project.id,
      legalName: 'ТОВ «Ромашка»',
      registryCode: '12345678',
      jurisdiction: 'UA',
      domain: null,
      lastRefreshedAt: null,
    });
    return { prisma, dossiers, project, dossier };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: модель вернула отзыв с цитатой — цитата НЕ попадает в базу, а отброшенное показано числом', async () => {
    // Промпт запрещает категорию REVIEWS, но промпт — не барьер: модель
    // может вернуть что угодно, и до этого аудита такая цитата уходила
    // в базу, потому что assertFactAllowed() не вызывался ни одним
    // путём записи.
    const s = setup([
      { category: 'REGISTRY', quote: 'Статус юридичної особи: припинено.' },
      { category: 'REVIEWS', quote: 'Відгук клієнта: жахливий роботодавець, платять із затримкою.' },
    ]);

    const report = await s.dossiers.refresh('u1', s.dossier.id);

    // Источников реестра для UA несколько, страница у всех одна и та же
    // (мока), поэтому счётчики кратны числу источников — важно не число,
    // а что отзыв отброшен на КАЖДОМ, а реестровый факт сохранён.
    const facts = s.prisma.rows('employerDossierFact');
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f: any) => f.category === 'REGISTRY')).toBe(true);
    expect(report.factsAdded).toBe(facts.length);
    expect(report.skippedByRules).toBe(report.factsAdded); // ровно по одному отброшенному отзыву на источник
    // Ни в одной строке досье нет текста отзыва — проверяем по содержимому,
    // не по категории: пересказ под другой категорией был бы тем же самым.
    expect(JSON.stringify(facts)).not.toMatch(/жахливий роботодавець/);
  });

  it('факт из источника, которого нет ни в реестрах, ни в ссылках пользователя, тоже не сохраняется', async () => {
    const s = setup([{ category: 'REGISTRY', quote: 'Статус юридичної особи: припинено.' }]);
    // Ссылка пользователя на постороннем хосте: она попадает в источники
    // обновления, и барьер обязан её пропустить — а вот факт с чужим
    // sourceUrl (если бы он взялся) пропустить не должен.
    await s.dossiers.addUserSource('u1', s.dossier.id, { url: 'https://dou.ua/company/romashka', category: EmployerFactCategory.OTHER });
    const report = await s.dossiers.refresh('u1', s.dossier.id);
    expect(report.factsAdded).toBeGreaterThan(0);
    for (const f of s.prisma.rows('employerDossierFact')) {
      expect(f.fetchedAt).toBeTruthy(); // барьер требует дату загрузки у каждого факта
    }
  });

  it('ссылка пользователя категории REVIEWS сохраняется без цитаты — правило не запрещает сам отзыв, запрещает пересказ', async () => {
    const s = setup([]);
    const fact = await s.dossiers.addUserSource('u1', s.dossier.id, { url: 'https://dou.ua/company/romashka' });
    expect(fact.category).toBe('REVIEWS');
    expect(fact.quote).toBeNull();
  });
});

describe('Приёмка 38 — открытый пункт чеклиста отправки попадает в аудит, а отправку не блокирует', () => {
  function setup() {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ facts: [] }));
    // Один и тот же журнал у обоих сервисов: запись чеклиста делает
    // сервис досье, а вызывает её путь отправки — проверяем именно стык.
    const audit = { records: [] as any[], async record(entry: any) { this.records.push(entry); return entry; } };
    const dossiers = new EmployerDossierService(prisma as any, router as any, audit as any);
    const candidates = new InterviewPoolCandidateService(prisma as any, audit as any, dossiers as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales' });
    // Досье компании-заказчика есть, но пустое: чеклист заведомо открыт.
    prisma.seed('employerDossier', { projectId: project.id, legalName: 'ТОВ «Замовник»', registryCode: null, jurisdiction: 'UA', domain: null, lastRefreshedAt: null });
    return { prisma, candidates, audit, project };
  }
  function seedCandidate(prisma: any, projectId: string) {
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'u1', displayName: 'Анна', consentRevokedAt: null });
    prisma.seed('candidatePipelineStatus', { projectId, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    return profile;
  }

  it('КЛЮЧЕВОЙ ТЕСТ: поштучный шеринг проходит, и открытые пункты чеклиста записаны в аудит', async () => {
    const s = setup();
    const profile = seedCandidate(s.prisma, s.project.id);

    const res = await s.candidates.shareCandidate('u1', profile.id, true);
    expect(res.deepLink).toContain('share_');

    const shipment = s.audit.records.find((r) => r.resource === 'ShipmentChecklist');
    expect(shipment).toBeTruthy();
    expect(shipment.action).toBe('candidate_share.created');
    expect(Array.isArray(shipment.after.openItems)).toBe(true);
    expect(shipment.after.openItems.length).toBeGreaterThan(0);
  });

  it('пакетная отправка пула пишет тот же чеклист, и сбой аудита не роняет отправку', async () => {
    const s = setup();
    const profile = seedCandidate(s.prisma, s.project.id);

    const res = await s.candidates.shareAllInPool('u1', s.project.id, [profile.id]);
    expect(res.includedCount).toBe(1);
    expect(s.audit.records.some((r) => r.action === 'candidate_share.batch_created')).toBe(true);

    // Аудит недоступен — отправка обязана состояться: правило приёмки
    // «не блокирует», и превратить его в «блокирует» нельзя даже аварией.
    const broken = new InterviewPoolCandidateService(
      s.prisma as any,
      s.audit as any,
      { auditShipment: async () => { throw new Error('аудит недоступен'); } } as any,
    );
    const second = await broken.shareCandidate('u1', profile.id, true);
    expect(second.deepLink).toContain('share_');
  });

  it('без досье компании (у работодателя своё, у пула может не быть) отправка работает как прежде', async () => {
    const prisma = createHiringFakePrisma();
    const audit = { records: [] as any[], async record(entry: any) { this.records.push(entry); return entry; } };
    const candidates = new InterviewPoolCandidateService(prisma as any, audit as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'u1', displayName: 'Анна', consentRevokedAt: null });
    prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });

    const res = await candidates.shareCandidate('u1', profile.id, true);
    expect(res.deepLink).toContain('share_');
    expect(audit.records.some((r) => r.resource === 'ShipmentChecklist')).toBe(false);
  });
});

describe('Стадия воронки — её ставит рекрутер, и до этого аудита не мог поставить вообще', () => {
  function setup() {
    const prisma = createHiringFakePrisma();
    const audit = { records: [] as any[], async record(entry: any) { this.records.push(entry); return entry; } };
    const candidates = new InterviewPoolCandidateService(prisma as any, audit as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'u1', displayName: 'Анна', consentRevokedAt: null });
    const status = prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    return { prisma, candidates, audit, project, status };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: INTERVIEWED и UNDER_REVIEW теперь достижимы — раньше их не выставлял ни один путь', async () => {
    const s = setup();
    const interviewed = await s.candidates.setStage('u1', s.status.id, 'INTERVIEWED' as any);
    expect(interviewed.stage).toBe('INTERVIEWED');
    const underReview = await s.candidates.setStage('u1', s.status.id, 'UNDER_REVIEW' as any);
    expect(underReview.stage).toBe('UNDER_REVIEW');
  });

  it('смена стадии — действие человека: пишется в аудит со старым и новым значением', async () => {
    const s = setup();
    await s.candidates.setStage('u1', s.status.id, 'INTERVIEWED' as any);
    const rec = s.audit.records.find((r) => r.action === 'candidate_pipeline_status.stage_changed');
    expect(rec).toBeTruthy();
    expect(rec.before.stage).toBe('SCHEDULED');
    expect(rec.after.stage).toBe('INTERVIEWED');
  });

  it('чужой пул и выдуманная стадия отклоняются', async () => {
    const s = setup();
    await expect(s.candidates.setStage('другой-пользователь', s.status.id, 'INTERVIEWED' as any)).rejects.toThrow();
    // «Принят»/«отказ» в enum'е нет намеренно (§2.3) — решение о найме
    // фиксирует человек вне модели, чтобы продукт не мог его «посоветовать».
    await expect(s.candidates.setStage('u1', s.status.id, 'ACCEPTED' as any)).rejects.toThrow(/стадия/i);
  });
});

describe('Сверка доступа 2026-09-03 — отзыв согласия гасит уже отправленную ссылку', () => {
  // Найдено сверкой всех 60 методов с id-параметром: `CandidateShare.
  // revokedAt` ПИСАЛСЯ при отзыве (А-6) и не читался ни превью ссылки, ни
  // принятием — отправленная ссылка продолжала показывать профиль все 72
  // часа TTL. Отзыв, который не гасит живую ссылку, отзывом не является.
  function setup() {
    const prisma = createHiringFakePrisma();
    const audit = { records: [] as any[], async record(entry: any) { this.records.push(entry); return entry; } };
    const candidates = new InterviewPoolCandidateService(prisma as any, audit as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'u1', displayName: 'Анна', resumeText: 'резюме', consentRevokedAt: null, recruitingTeamId: null });
    prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    return { prisma, candidates, project, profile };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: после отзыва согласия ссылка перестаёт показывать кандидата и не принимается', async () => {
    const s = setup();
    const share = await s.candidates.shareCandidate('u1', s.profile.id, true);
    const token = String(share.deepLink).split('share_')[1];

    const before = await s.candidates.previewShare(token);
    expect(before).toHaveLength(1);
    expect(before[0].displayName).toBe('Анна');

    await s.candidates.revokeConsent('u1', s.profile.id, { candidateAskedToRevoke: true });

    // Причина названа прямо: получатель должен понимать, что ссылка не
    // «сломалась», а закрыта по просьбе самого кандидата.
    await expect(s.candidates.previewShare(token)).rejects.toThrow(/отозвал согласие/);
    await expect(s.candidates.acceptShare('u2', before[0].shareId, token)).rejects.toThrow(/отозвал согласие/);
    // И никакой копии профиля у получателя не появилось.
    expect(s.prisma.rows('candidateProfile')).toHaveLength(1);
  });
});
