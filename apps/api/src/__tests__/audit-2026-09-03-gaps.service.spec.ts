// Пункт [job-domain-v2] — аудит 2026-09-03: сверка реестра §12 с кодом нашла
// четыре пробела, ниже — тесты на их закрытие.
//
//   А-6  — отзыв согласия читался в двух местах из шести; отчёты, снимки и
//          доставка работодателю про него не знали;
//   К-22 — импорта готового резюме не было вовсе (поле схемы было, кода нет);
//   §11.40 — барьер утверждения «каждый элемент опирается на документ»;
//   А-28 — выжимки о компании для кандидата не было вовсе.
import { MAX_COPY_CHAIN_DEPTH } from '../interview-pool/consent-revocation';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InterviewPoolReportService } from '../interview-pool/interview-pool-report.service';
import { InterviewPoolCandidateService } from '../interview-pool/interview-pool-candidate.service';
import { EngagementService } from '../employer-hiring/engagement.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { CvImportService, CV_IMPORT_TASK_TYPE } from '../job-search/cv-import.service';
import {
  assertEveryElementHasEvidence,
  cvDraftElementPaths,
  missingEvidencePaths,
  sanitizeCvEvidence,
} from '../job-search/cv-evidence';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { VacancyPostingService } from '../vacancy-posting/vacancy-posting.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { VacancyIntakeService } from '../vacancy-intake/vacancy-intake.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

jest.mock('../common/safe-url-fetch', () => ({ fetchUrlText: jest.fn(async () => ({ text: '', finalUrl: '' })) }));

const DOC = [
  'Иван Петров — backend-разработчик',
  'Пять лет пишу сервисы на Node.js и TypeScript.',
  'ООО «Ромашка», 2021–2024, старший разработчик.',
  'Перевёл биллинг на очереди и снизил число ночных инцидентов.',
  'Навыки: Node.js, PostgreSQL, Docker.',
  'КПИ, прикладная математика.',
].join('\n');

const DRAFT_FROM_DOC = {
  headline: 'backend-разработчик',
  summary: 'Пять лет пишу сервисы на Node.js и TypeScript.',
  skills: ['Node.js', 'PostgreSQL'],
  experience: [{ period: '2021–2024', place: 'ООО «Ромашка»', role: 'старший разработчик', highlights: ['Перевёл биллинг на очереди'] }],
  education: ['КПИ, прикладная математика'],
};

const EVIDENCE_FOR_DRAFT = [
  { path: 'headline', quote: 'backend-разработчик' },
  { path: 'summary', quote: 'Пять лет пишу сервисы на Node.js и TypeScript.' },
  { path: 'skills[0]', quote: 'Node.js' },
  { path: 'skills[1]', quote: 'PostgreSQL' },
  { path: 'experience[0]', quote: 'ООО «Ромашка», 2021–2024, старший разработчик.' },
  { path: 'experience[0].highlights[0]', quote: 'Перевёл биллинг на очереди' },
  { path: 'education[0]', quote: 'КПИ, прикладная математика' },
];

describe('А-6 — отзыв согласия кандидата останавливает всё, что покидает проект', () => {
  function setup() {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ text: 'вывод' }));
    const reports = new InterviewPoolReportService(prisma as any, router as any);
    const candidates = new InterviewPoolCandidateService(prisma as any, fakeAudit as any);
    const engagements = new EngagementService(prisma as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales' });
    return { prisma, reports, candidates, engagements, project };
  }
  function seedCandidate(prisma: any, projectId: string, name: string, revoked = false) {
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'u2', displayName: name, consentRevokedAt: revoked ? new Date() : null });
    const status = prisma.seed('candidatePipelineStatus', { projectId, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    return { profile, status };
  }

  it('отчёт по кандидату с отозванным согласием не формируется (403), по остальным — как прежде', async () => {
    const s = setup();
    const ok = seedCandidate(s.prisma, s.project.id, 'Иван');
    const revoked = seedCandidate(s.prisma, s.project.id, 'Пётр', true);
    await expect(s.reports.generateCandidateReport('u2', s.project.id, revoked.profile.id)).rejects.toBeInstanceOf(ForbiddenException);
    const report = await s.reports.generateCandidateReport('u2', s.project.id, ok.profile.id);
    expect(report.candidateProfileId).toBe(ok.profile.id);
  });

  it('сводный отчёт заказчику исключает отозвавших и называет их число — молча уменьшившаяся воронка читалась бы как потеря данных', async () => {
    const s = setup();
    seedCandidate(s.prisma, s.project.id, 'Иван');
    seedCandidate(s.prisma, s.project.id, 'Пётр', true);
    const report = await s.reports.generateSummaryReport('u2', s.project.id);
    const content = report.content as any;
    expect(content.funnel.totalCandidates).toBe(1);
    expect(content.entries.map((e: any) => e.displayName)).toEqual(['Иван']);
    expect(content.excludedByRevokedConsent).toBe(1);
    expect(JSON.stringify(content)).not.toContain('Пётр');
  });

  it('доставка готового отчёта работодателю останавливается, если кандидат отозвал согласие после ревью', async () => {
    const s = setup();
    const cand = seedCandidate(s.prisma, s.project.id, 'Иван');
    const employerProject = s.prisma.seed('project', { ownerId: 'u3', mode: 'EMPLOYER_HIRING' });
    const engagement = s.prisma.seed('employerAgencyEngagement', {
      employerProjectId: employerProject.id,
      agencyProjectId: s.project.id,
      status: 'ACTIVE',
      token: 'tok',
      sharedItems: [],
      // Пункт [term-never-ends] 2026-09-06: `expiresAt` в фикстуре не
      // было ВООБЩЕ — и это ничему не мешало, потому что код срок не
      // читал. Поле обязательно по схеме; фикстура, обходившаяся без
      // него, и есть след того, что проверки не существовало.
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const report = s.prisma.seed('clientReport', {
      projectId: s.project.id,
      type: 'PER_CANDIDATE',
      candidateProfileId: cand.profile.id,
      content: {},
      reviewedAt: new Date(),
    });
    // до отзыва — доставка проходит
    const delivered = await s.engagements.deliverReport('u2', report.id, engagement.id);
    expect(delivered.deliveredToProjectId).toBe(employerProject.id);
    // после отзыва — нет
    cand.profile.consentRevokedAt = new Date();
    const second = s.prisma.seed('clientReport', { projectId: s.project.id, type: 'PER_CANDIDATE', candidateProfileId: cand.profile.id, content: {}, reviewedAt: new Date() });
    await expect(s.engagements.deliverReport('u2', second.id, engagement.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('рекрутер записывает отзыв, полученный вне продукта: нужен явный признак «кандидат попросил», ссылки гасятся, повтор идемпотентен', async () => {
    const s = setup();
    const cand = seedCandidate(s.prisma, s.project.id, 'Иван');
    s.prisma.seed('candidateShare', { sourceCandidateId: cand.profile.id, shareToken: 't1', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });
    await expect(s.candidates.revokeConsent('u2', cand.profile.id, { candidateAskedToRevoke: false })).rejects.toBeInstanceOf(BadRequestException);
    const res = await s.candidates.revokeConsent('u2', cand.profile.id, { candidateAskedToRevoke: true, note: 'написал в почту' });
    expect(res.consentRevokedAt).toBeInstanceOf(Date);
    expect(res.sharesRevoked).toBe(1);
    expect(s.prisma.rows('candidateShare')[0].revokedAt).toBeInstanceOf(Date);
    const again = await s.candidates.revokeConsent('u2', cand.profile.id, { candidateAskedToRevoke: true });
    expect(again.alreadyRevoked).toBe(true);
    // чужой профиль не отзывается
    const foreign = s.prisma.seed('candidateProfile', { ownerUserId: 'other', displayName: 'Чужой' });
    await expect(s.candidates.revokeConsent('u2', foreign.id, { candidateAskedToRevoke: true })).rejects.toThrow(/not found/);
  });

  // ── Пункт [copy-outlived-consent] 2026-09-24 ──
  //
  // Отзыв гасил исходный профиль и строки шеринга — но НЕ копии, уже
  // принятые другой стороной в свой проект. У копии оставалось
  // `consentRevokedAt: null`, `assertConsentActive` там проходил, и по
  // человеку, попросившему его убрать, продолжали формироваться отчёты.
  // Соседний маршрут (самошеринг) копию гасил с самого начала.
  it('КЛЮЧЕВОЙ ТЕСТ [copy-outlived-consent]: отзыв догоняет принятую копию, и копию копии', async () => {
    const s = setup();
    const cand = seedCandidate(s.prisma, s.project.id, 'Иван');
    // агентство приняло кандидата к себе — появилась копия
    const copy1 = s.prisma.seed('candidateProfile', { ownerUserId: 'агентство', displayName: 'Иван', sharedFromProjectId: s.project.id });
    s.prisma.seed('candidateShare', { sourceCandidateId: cand.profile.id, createdCandidateProfileId: copy1.id, shareToken: 't1', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });
    // агентство поделилось дальше — появилась копия копии
    const copy2 = s.prisma.seed('candidateProfile', { ownerUserId: 'работодатель', displayName: 'Иван' });
    s.prisma.seed('candidateShare', { sourceCandidateId: copy1.id, createdCandidateProfileId: copy2.id, shareToken: 't2', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });

    const res = await s.candidates.revokeConsent('u2', cand.profile.id, { candidateAskedToRevoke: true });

    // Главное утверждение пункта: копии больше не в работе.
    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy1.id)!.consentRevokedAt).toBeInstanceOf(Date);
    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === copy2.id)!.consentRevokedAt).toBeInstanceOf(Date);
    // И человеку названо, сколько именно копий остановлено — отдельно от
    // ссылок: «ссылку закрыли» и «данные у принявшего не в работе» для
    // него разные новости.
    expect(res.copiesRevoked).toBe(2);
    expect(res.sharesRevoked).toBe(2);
    expect(res.depthExhausted).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [copy-outlived-consent]: цепочка длиннее потолка — обход честно говорит, что не дошёл', async () => {
    // Это и есть смысл потолка: не «молча остановиться», а остановиться
    // и СКАЗАТЬ. Ответ «отозвано везде» при недошедшем обходе — ровно та
    // неправда, которую весь пункт и убирает, только изнутри самой
    // починки.
    const s = setup();
    const root = seedCandidate(s.prisma, s.project.id, 'Иван');
    let prev = root.profile.id;
    const chain: string[] = [];
    for (let i = 0; i < MAX_COPY_CHAIN_DEPTH + 2; i++) {
      const next = s.prisma.seed('candidateProfile', { ownerUserId: `получатель-${i}`, displayName: 'Иван' });
      s.prisma.seed('candidateShare', { sourceCandidateId: prev, createdCandidateProfileId: next.id, shareToken: `ch-${i}`, revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });
      chain.push(next.id);
      prev = next.id;
    }

    const res = await s.candidates.revokeConsent('u2', root.profile.id, { candidateAskedToRevoke: true });

    expect(res.depthExhausted).toBe(true);
    // И число названо честное: столько, сколько реально погашено, а не
    // столько, сколько их всего.
    expect(res.copiesRevoked).toBeLessThan(chain.length);
    expect(res.copiesRevoked).toBeGreaterThan(0);
    // Дальний конец цепочки действительно остался нетронутым — значит
    // флаг говорит о настоящем положении дел, а не поставлен для вида.
    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === chain[chain.length - 1])!.consentRevokedAt ?? null).toBeNull();
  });

  it('[copy-outlived-consent]: цикл в родословной не зацикливает обход, и упёртый потолок назван', async () => {
    const s = setup();
    const a = seedCandidate(s.prisma, s.project.id, 'Иван');
    const b = s.prisma.seed('candidateProfile', { ownerUserId: 'другой', displayName: 'Иван' });
    // A → B и B → A: в данных такое ничем не запрещено.
    s.prisma.seed('candidateShare', { sourceCandidateId: a.profile.id, createdCandidateProfileId: b.id, shareToken: 'c1', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });
    s.prisma.seed('candidateShare', { sourceCandidateId: b.id, createdCandidateProfileId: a.profile.id, shareToken: 'c2', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });

    const res = await s.candidates.revokeConsent('u2', a.profile.id, { candidateAskedToRevoke: true });

    expect(s.prisma.rows('candidateProfile').find((p: any) => p.id === b.id)!.consentRevokedAt).toBeInstanceOf(Date);
    // Обход закончился: уже виденное не обходится заново.
    expect(res.depthExhausted).toBe(false);
  });
});

describe('К-22 / приёмка 40 — импорт резюме только с опорой на документ', () => {
  it('пути элементов перечисляются полностью; цитата не из документа опорой не считается', () => {
    expect(cvDraftElementPaths(DRAFT_FROM_DOC as any)).toEqual([
      'headline',
      'summary',
      'skills[0]',
      'skills[1]',
      'education[0]',
      'experience[0]',
      'experience[0].highlights[0]',
    ]);
    const clean = sanitizeCvEvidence(
      [
        { path: 'headline', quote: 'backend-разработчик' },
        { path: 'summary', quote: 'Руководил командой из 10 человек' }, // в документе такого нет
        { path: 'skills[9]', quote: 'Node.js' }, // несуществующий путь
        { path: 'skills[0]', quote: 'Node.js' },
        { path: 'skills[0]', quote: 'Node.js' }, // дубль
      ],
      DRAFT_FROM_DOC as any,
      DOC,
    );
    expect(clean.map((c) => c.path)).toEqual(['headline', 'skills[0]']);
  });

  it('барьер утверждения: черновик из онбординга проходит, импортированный с «улучшенной» строкой — 400 с человеческим списком', () => {
    // из онбординга — опор нет по построению, барьер молчит
    expect(() => assertEveryElementHasEvidence(DRAFT_FROM_DOC, null)).not.toThrow();
    // импортированный и полностью опёртый — проходит
    expect(() =>
      assertEveryElementHasEvidence(DRAFT_FROM_DOC, { sourceRef: null, importedAt: '', sourceText: DOC, items: EVIDENCE_FOR_DRAFT }),
    ).not.toThrow();
    // одна строка без опоры — не утверждается, и в тексте ошибки видно какая
    const partial = EVIDENCE_FOR_DRAFT.filter((e) => e.path !== 'experience[0].highlights[0]');
    expect(missingEvidencePaths(DRAFT_FROM_DOC as any, partial)).toEqual(['experience[0].highlights[0]']);
    try {
      assertEveryElementHasEvidence(DRAFT_FROM_DOC, { sourceRef: null, importedAt: '', sourceText: DOC, items: partial });
      throw new Error('ожидалось исключение');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('Перевёл биллинг на очереди');
      expect((err as Error).message).toContain('ООО «Ромашка»');
      expect((err as Error).message).not.toMatch(/highlights\[0\]/); // не путь, а человеческое имя
    }
  });

  it('импорт: выдуманный моделью элемент остаётся в черновике, но без опоры и с честным предупреждением; утверждение снимается', async () => {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter((req) => {
      if (req.taskType !== CV_IMPORT_TASK_TYPE) return '{}';
      return JSON.stringify({
        draft: { ...DRAFT_FROM_DOC, skills: [...DRAFT_FROM_DOC.skills, 'Kubernetes'] }, // в документе Kubernetes нет
        evidence: [...EVIDENCE_FOR_DRAFT, { path: 'skills[2]', quote: 'Kubernetes' }],
      });
    });
    const svc = new CvImportService(prisma as any, router as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null, cvReviewedAt: new Date(), cvText: 'старое' });

    const res = await svc.importCv('u1', project.id, { text: DOC, sourceRef: 'файл резюме' });
    expect(res.missing.map((m: any) => m.path)).toEqual(['skills[2]']);
    expect(res.missing[0].label).toContain('Kubernetes');
    expect(res.evidenceCount).toBe(EVIDENCE_FOR_DRAFT.length);
    const cfg = prisma.rows('jobSearchConfig')[0];
    expect((cfg.cvDraft as any).skills).toContain('Kubernetes'); // не выбрасываем молча
    expect(cfg.cvReviewedAt).toBeNull(); // но и утверждённым импорт не делает
    expect((cfg.cvDraftEvidence as any).sourceText).toBe(DOC);

    // правка руками: убрали выдуманный навык — опоры пересчитались, пробелов нет
    const edited = await svc.updateDraft('u1', project.id, DRAFT_FROM_DOC as any);
    expect(edited.missing).toEqual([]);
  });
});

describe('А-28 — выжимка о компании для кандидата', () => {
  it('только проверяемые факты с цитатой и ссылкой; отзывы — ссылками без цитат; непроверенный представитель не показывается; оценок компании нет', async () => {
    const prisma = createHiringFakePrisma();
    const svc = new EmployerDossierService(prisma as any, createFakeRouter(() => '{}') as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const dossier = prisma.seed('employerDossier', { projectId: project.id, legalName: 'ТОВ Ромашка', registryCode: '12345678', domain: 'romashka.ua', jurisdiction: 'UA', confirmedAt: new Date() });
    prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'REGISTRY', quote: 'зареєстровано 2015', sourceUrl: 'https://registry.ua/1', fetchedAt: new Date() });
    prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'REVIEWS', quote: null, sourceUrl: 'https://otzyv.example/1', fetchedAt: new Date() });
    prisma.seed('employerRepresentativeClaim', { dossierId: dossier.id, displayName: 'Анна', claimedRole: 'HR', contactDomain: 'romashka.ua', check: 'CONFIRMED_PUBLIC', checkedAt: new Date() });
    prisma.seed('employerRepresentativeClaim', { dossierId: dossier.id, displayName: 'Некто', claimedRole: 'рекрутер', contactDomain: 'gmail.com', check: 'AS_STATED' });

    const out = await svc.candidateSummary('u2', dossier.id);
    expect(out.company).toMatchObject({ legalName: 'ТОВ Ромашка', registryCode: '12345678', confirmed: true });
    expect(out.facts.map((f: any) => f.category)).toEqual(['REGISTRY']);
    expect(out.facts[0]).toMatchObject({ quote: 'зареєстровано 2015', sourceUrl: 'https://registry.ua/1' });
    expect(out.reviewLinks).toEqual([expect.objectContaining({ url: 'https://otzyv.example/1' })]);
    expect(JSON.stringify(out.reviewLinks)).not.toContain('quote');
    expect(out.representatives.map((r: any) => r.displayName)).toEqual(['Анна']);
    expect(out.gaps).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/score|rating|рейтинг|надёжност|балл/i);
  });

  it('пробелы названы прямо: без кода реестра и подтверждения выжимка это говорит, а не выглядит полной', async () => {
    const prisma = createHiringFakePrisma();
    const svc = new EmployerDossierService(prisma as any, createFakeRouter(() => '{}') as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const dossier = prisma.seed('employerDossier', { projectId: project.id, legalName: null, registryCode: null, domain: 'romashka.ua', jurisdiction: 'UA', confirmedAt: null });
    const out = await svc.candidateSummary('u2', dossier.id);
    expect(out.gaps).toEqual(['код в реестре не указан', 'нет ни одного факта из государственного реестра', 'компания не подтверждена вами']);
    expect(out.facts).toEqual([]);
  });
});

describe('Остаток списка аудита — приёмка 25, 44 и К-3', () => {
  function hiring() {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => '{}');
    const matching = new TermsMatchingService(prisma as any, router as any);
    const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
    return { prisma, router, matching, sheets };
  }

  it('приёмка 25: копия оффера переживает удаление проекта-источника и показывается с пометкой «источник удалён»', async () => {
    const s = hiring();
    const project = s.prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    s.prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
    const vacancy = s.prisma.seed('jobVacancy', { configId: s.prisma.rows('jobSearchConfig')[0].id, sourceUrl: 'https://x/1', siteHost: 'x', rawText: 'текст', title: 'T', duplicateOfId: null });
    const sheet = s.prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: vacancy.id, title: 'T', status: 'DRAFT' });
    const employerProject = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING' });
    s.prisma.seed('offerDocument', { sheetId: sheet.id, rawText: 'оффер', source: 'employer-offer:1', sharedFromProjectId: employerProject.id, sharedAt: new Date() });

    const alive = await s.sheets.get('u1', sheet.id);
    expect(alive.offers[0]).toMatchObject({ sourceDeleted: false });

    // работодатель удалил аккаунт: его проект исчез, копия у соискателя — нет
    s.prisma.tables.set('project', s.prisma.rows('project').filter((p: any) => p.id !== employerProject.id));
    const after = await s.sheets.get('u1', sheet.id);
    expect(after.offers).toHaveLength(1);
    expect(after.offers[0]).toMatchObject({ sourceDeleted: true, rawText: 'оффер' });
  });

  it('приёмка 44: агентские функции недоступны работодателю — 404 «не применимо к роли», а не пустой ответ', async () => {
    const s = hiring();
    const router = createFakeRouter(() => '{}');
    const postings = new VacancyPostingService(s.prisma as any, router as any, s.sheets);
    const briefs = new ClientBriefService(s.prisma as any, router as any, s.sheets, s.matching);
    const employer = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING', recruitingTeamId: null });
    s.prisma.seed('employerDossier', { projectId: employer.id, legalName: 'ТОВ Ромашка', registryCode: '1', jurisdiction: 'UA' });
    const config = s.prisma.seed('interviewPoolConfig', { projectId: employer.id, jobTitle: 'Sales' });
    const posting = s.prisma.seed('vacancyPosting', { projectId: employer.id });
    const revision = s.prisma.seed('vacancyPostingRevision', { postingId: posting.id, text: 'текст вакансии', checks: null });

    // А-30: согласование по ссылке вне продукта
    await expect(postings.createReviewShare('emp', revision.id)).rejects.toThrow(/не применимо к роли/);
    // А-29: история брифов заказчика
    await expect(briefs.diffAgainstPrevious('emp', employer.id)).rejects.toThrow(/не применимо к роли/);
    void config;
  });

  it('приёмка 44 / А-25: работодатель не собирает досье на ЧУЖУЮ компанию — но своё (Р-6) уточняет свободно', async () => {
    const s = hiring();
    const dossiers = new EmployerDossierService(s.prisma as any, createFakeRouter(() => '{}') as any, fakeAudit as any);
    const employer = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING', recruitingTeamId: null });

    // Р-6: собственная компания заводится и УТОЧНЯЕТСЯ (домен и код к тому же названию)
    const own = await dossiers.identify('emp', employer.id, { legalName: 'ТОВ Ромашка' });
    expect(own.legalName).toBe('ТОВ Ромашка');
    const refined = await dossiers.identify('emp', employer.id, { legalName: 'ТОВ Ромашка', registryCode: '12345678' });
    expect(refined.id).toBe(own.id);
    expect(refined.registryCode).toBe('12345678');

    // А-25: вторая, чужая компания в проекте работодателя — не его функция
    await expect(dossiers.identify('emp', employer.id, { legalName: 'ТОВ Конкурент', registryCode: '87654321' })).rejects.toThrow(/А-25: не применимо к роли/);

    // у агентства и соискателя та же операция работает: досье по компании на заказчика/вакансию
    const agency = s.prisma.seed('project', { ownerId: 'ag', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    await dossiers.identify('ag', agency.id, { legalName: 'ТОВ Первый', registryCode: '11111111' });
    await dossiers.identify('ag', agency.id, { legalName: 'ТОВ Второй', registryCode: '22222222' });
    expect(await dossiers.list('ag', agency.id)).toHaveLength(2);

    const candidate = s.prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    await dossiers.identify('u1', candidate.id, { legalName: 'ТОВ Работодатель А', registryCode: '33333333' });
    await dossiers.identify('u1', candidate.id, { legalName: 'ТОВ Работодатель Б', registryCode: '44444444' });
    expect(await dossiers.list('u1', candidate.id)).toHaveLength(2);
  });

  it('К-3: отклик отмечается руками — до этого «молчат N дней» видел только импортированную историю', async () => {
    const prisma = createHiringFakePrisma();
    const intake = new VacancyIntakeService(prisma as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
    const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://x/1', siteHost: 'x', rawText: 'текст', title: 'T', duplicateOfId: null, responseStatus: null, responseStatusAt: null });

    expect(await intake.silence('u1', project.id)).toEqual([]);
    const marked = await intake.setResponseStatus('u1', vacancy.id, 'APPLIED' as never);
    expect(marked.responseStatus).toBe('APPLIED');
    expect(marked.responseStatusAt).toBeInstanceOf(Date);

    // через восемь дней вакансия попадает в сводку «молчат»
    prisma.rows('jobVacancy')[0].responseStatusAt = new Date(Date.now() - 8 * 86_400_000);
    const silent = await intake.silence('u1', project.id, 7);
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ id: vacancy.id, responseStatus: 'APPLIED', silentDays: 8 });

    // отметку можно снять — человек мог ошибиться
    const cleared = await intake.setResponseStatus('u1', vacancy.id, null);
    expect(cleared.responseStatus).toBeNull();
    expect(cleared.responseStatusAt).toBeNull();
  });
});
