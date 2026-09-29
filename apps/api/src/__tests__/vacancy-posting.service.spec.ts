// Пункт [job-domain-v2] — связка Т, приёмка 29–33 + детерминированные проверки.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VacancyPostingService, POSTING_DRAFT_PROMPT, POSTING_CHECK_PROMPT } from '../vacancy-posting/vacancy-posting.service';
import { runPostingChecks, deriveVariantText, detectLang, lineDiff, readabilityIssues, mentionedIn } from '../vacancy-posting/posting-checks';
import { presentNorm, LEGAL_NORMS } from '../vacancy-posting/legal-norms';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

const TEXT = `Sales-менеджер
Ищем менеджера по продажам в B2B.

Обязательно:
- Опыт B2B-продаж от 2 лет
- Работа с CRM

Желательно:
- Английский B2

Условия:
Формат работы: удалённо. Оплата 1000-1500 USD. Молодой коллектив.

Процесс отбора:
- Звонок с HR
- Интервью с руководителем

Как откликнуться:
Напишите нам.`;

function setup(handler: (req: any) => string) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const postings = new VacancyPostingService(prisma as any, router as any, sheets);
  return { prisma, router, sheets, postings };
}

function seedAgency(prisma: any, mode = 'INTERVIEW_POOL') {
  const team = prisma.seed('recruitingTeam', { name: 't', teamType: mode === 'EMPLOYER_HIRING' ? 'EMPLOYER' : 'AGENCY' });
  prisma.seed('recruitingTeamMember', { teamId: team.id, userId: 'u', role: 'OWNER' });
  const project = prisma.seed('project', { ownerId: 'u', mode, recruitingTeamId: team.id });
  const config = prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales', salaryRange: '1000-1500 USD', workArrangement: 'REMOTE', officeLocation: null });
  prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт B2B-продаж?', orderIndex: 0, isRequired: true });
  prisma.seed('questionnaireItem', { configId: config.id, text: 'Какая у вас была зарплата на прошлом месте?', orderIndex: 1, isRequired: false });
  if (mode === 'EMPLOYER_HIRING') prisma.seed('employerDossier', { projectId: project.id, registryCode: '12345678', jurisdiction: 'UA' });
  return { team, project, config };
}

describe('posting-checks — детерминированные проверки', () => {
  it('runPostingChecks: оплата, вопрос о прошлой зарплате, текст против конфига, требования ↔ анкета', () => {
    const clauses = [
      { id: 'c1', side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Опыт B2B-продаж от 2 лет', isRequired: true, sourceQuestionnaireItemId: 'q1', sourceEvidence: null, sourceQuote: null },
      { id: 'c2', side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Работа с CRM', isRequired: true, sourceQuestionnaireItemId: null, sourceEvidence: 'CLIENT_BRIEF', sourceQuote: 'CRM' },
      { id: 'c3', side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Готовность к командировкам', isRequired: true, sourceQuestionnaireItemId: null, sourceEvidence: null, sourceQuote: null },
    ] as any;
    const checks = runPostingChecks(TEXT, { jobTitle: 'Sales', salaryRange: '1000-1500 USD', workArrangement: 'OFFICE', officeLocation: 'Львов', employmentLoad: null, questions: [{ id: 'q1', text: 'Опыт B2B-продаж?' }, { id: 'q2', text: 'Какая у вас была зарплата на прошлом месте?' }] }, clauses);
    expect(checks.salaryDisclosed).toBe(true);
    expect(checks.pastSalaryQuestion).toHaveLength(1);
    expect(checks.configDiscrepancies.map((d) => d.field).sort()).toEqual(['officeLocation', 'workArrangement']);
    // А-13 (исправлено аудитом 2026-09-03): требование без вопроса анкеты
    // показывается ВСЕГДА, а не только когда оно уже попало в текст. c3 —
    // ровно инфляция требований: в листе есть, вопроса нет, в тексте нет,
    // проверять его на собеседовании никто не будет. Раньше фильтр по тексту
    // прятал именно этот случай.
    expect(checks.clauseLinks.requirementsWithoutQuestion.map((r) => r.clauseId)).toEqual(['c2', 'c3']);
    expect(checks.clauseLinks.requirementsNotInText.map((r) => r.clauseId)).toEqual(['c3']); // командировки в тексте нет
    expect(checks.clauseLinks.questionsWithoutRequirementInText.map((q) => q.questionId)).toEqual(['q2']);
    expect(JSON.stringify(checks)).not.toMatch(/"(score|quality|rating)"/);
  });

  it('readability: длинное предложение, аббревиатура без расшифровки, непроверяемое требование', () => {
    const issues = readabilityIssues('Нужен стрессоустойчивый специалист со знанием RTB и ' + 'слово '.repeat(35) + '.');
    expect(issues.map((i) => i.kind).sort()).toEqual(['abbreviation', 'long_sentence', 'unverifiable']);
    expect(readabilityIssues('Работа с CRM (система учёта клиентов).')).toEqual([]);
  });

  it('варианты — детерминированные срезы; язык; диф', () => {
    expect(deriveVariantText(TEXT, 'full')).toBe(TEXT);
    const short = deriveVariantText(TEXT, 'short');
    expect(short).toContain('Обязательно');
    expect(short).not.toContain('Как откликнуться');
    expect(deriveVariantText(TEXT, 'telegram').length).toBeLessThanOrEqual(1000);
    expect(deriveVariantText(TEXT, 'career_page')).not.toContain('Напишите нам');
    expect(detectLang(TEXT)).toBe('ru');
    expect(detectLang('Шукаємо менеджера')).toBe('uk');
    expect(detectLang('Looking for a manager')).toBe('en');
    expect(lineDiff('a\nb', 'b\nc')).toEqual({ added: ['c'], removed: ['a'] });
    expect(mentionedIn(TEXT, 'Опыт B2B-продаж от 2 лет')).toBe(true);
  });

  it('приёмка 32: номер нормы — только при LEGAL_REFERENCES_CONFIRMED=true; нейтральный текст — всегда', () => {
    expect(presentNorm('UA_ADVERTISING_PROTECTED', {})).toEqual({ normKey: 'UA_ADVERTISING_PROTECTED', normText: LEGAL_NORMS.UA_ADVERTISING_PROTECTED.neutral });
    expect(presentNorm('UA_ADVERTISING_PROTECTED', { LEGAL_REFERENCES_CONFIRMED: 'true' }).normReference).toContain('24¹');
    expect(presentNorm('PROXY', { LEGAL_REFERENCES_CONFIRMED: 'true' }).normReference).toBeUndefined();
    expect(presentNorm(null)).toEqual({ normKey: null, normText: null });
    expect(POSTING_CHECK_PROMPT).not.toMatch(/24¹|2023\/970/);
    expect(POSTING_DRAFT_PROMPT).toMatch(/ЗАПРЕЩЕНО/);
  });
});

describe('VacancyPostingService', () => {
  const draftHandler = (req: any) => {
    if (req.taskType === 'vacancy-posting-draft') return JSON.stringify({ text: TEXT });
    if (req.taskType === 'vacancy-posting-check') return JSON.stringify({ flags: [{ category: 'возраст (прокси)', quotedText: 'Молодой коллектив', normKey: 'UA_ADVERTISING_PROTECTED', alternativeText: 'Дружная команда' }, { category: 'x', quotedText: 'нет в тексте', normKey: 'PROXY', alternativeText: 'y' }] });
    if (req.taskType === 'vacancy-posting-translate') return req.systemPrompt.includes('Переведи') ? JSON.stringify({ text: 'Sales manager\nLooking for B2B sales.\n\nMust:\n- 2 years of B2B sales' }) : JSON.stringify({ lost: ['Работа с CRM'], added: [] });
    if (req.taskType === 'vacancy-posting-reader-questions') return JSON.stringify({ questions: [{ topic: 'испытательный срок', question: 'Есть ли испытательный срок?' }] });
    return JSON.stringify({ clauses: [] });
  };

  it('КЛЮЧЕВОЙ ТЕСТ [one-of-several-spoke-for-all]: юрисдикция берётся по ВСЕМ компаниям проекта, а не по одной', async () => {
    // Раньше право, по которому проверяется объявление, выбиралось
    // произвольным `findFirst`: если первой оказывалась иностранная
    // компания, флаг об украинской версии текста не поднимался вовсе —
    // и человек читал «замечаний нет» там, где их не смотрели.
    const s = setup(draftHandler);
    const a = seedAgency(s.prisma, 'EMPLOYER_HIRING');
    // Первой по времени — иностранная компания, второй — украинская.
    s.prisma.rows('employerDossier').forEach((d: any) => { if (d.projectId === a.project.id) d.jurisdiction = 'PL'; });
    s.prisma.seed('employerDossier', { projectId: a.project.id, registryCode: '87654321', jurisdiction: 'UA', createdAt: new Date('2027-01-01') });

    const rev = await s.postings.draftFromSheet('u', a.project.id);
    const check = await s.postings.check('u', rev.id);
    expect(check.complianceFlags.some((f: { normKey: string | null }) => f.normKey === 'UA_LANGUAGE')).toBe(true);
  });

  it('ОБРАТНАЯ ПРОБА: все компании неукраинские — флага об украинской версии нет', async () => {
    // Без неё проверка выше проходила бы и в мире, где флаг поднимается
    // всегда, независимо от юрисдикции.
    const s = setup(draftHandler);
    const a = seedAgency(s.prisma, 'EMPLOYER_HIRING');
    s.prisma.rows('employerDossier').forEach((d: any) => { if (d.projectId === a.project.id) d.jurisdiction = 'PL'; });

    const rev = await s.postings.draftFromSheet('u', a.project.id);
    const check = await s.postings.check('u', rev.id);
    expect(check.complianceFlags.some((f: { normKey: string | null }) => f.normKey === 'UA_LANGUAGE')).toBe(false);
  });

  it('приёмка 29/31: черновик из листа — редакция; check → checks без агрегата + ComplianceFlag с цитатой (фантомная цитата отброшена); trace — «добавлено агентством» без цитаты брифа', async () => {
    const s = setup(draftHandler);
    const a = seedAgency(s.prisma);
    const rev = await s.postings.draftFromSheet('u', a.project.id);
    expect(rev.text).toBe(TEXT);
    expect(rev.reviewedAt).toBeNull();
    const structure = s.router.calls.find((c) => c.taskType === 'vacancy-posting-draft')!.userPrompt;
    expect(structure).toContain('Опыт B2B-продаж?'); // must — из анкеты (isRequired)
    expect(structure).toContain('Оплата: 1000-1500 USD');

    const check = await s.postings.check('u', rev.id);
    expect(check.checks.salaryDisclosed).toBe(true);
    expect(check.checks.pastSalaryQuestion).toHaveLength(1);
    // два флага: прокси-признак из AI + украинская версия (текст русский, юрисдикция UA); фантомная цитата отброшена
    expect(check.complianceFlags).toHaveLength(2);
    expect(check.complianceFlags[0]).toMatchObject({ quotedText: 'Молодой коллектив', alternativeText: 'Дружная команда', normKey: 'UA_ADVERTISING_PROTECTED' });
    expect(check.complianceFlags[1].normKey).toBe('UA_LANGUAGE');
    expect(check.complianceFlags.every((f) => !('normReference' in f))).toBe(true); // без LEGAL_REFERENCES_CONFIRMED
    expect(JSON.stringify(check.checks)).not.toMatch(/"(score|quality|rating)"/);
    // повторный check дублей не плодит
    await s.postings.check('u', rev.id);
    expect(s.prisma.rows('complianceFlag').filter((f) => f.postingRevisionId === rev.id)).toHaveLength(2);

    const trace = await s.postings.trace('u', rev.id);
    expect(trace.items.every((i) => i.label === 'добавлено агентством' && i.origin === 'added')).toBe(true);
    // пункт из брифа с цитатой → «из брифа»
    const sheet = s.prisma.rows('termsSheet').find((x) => x.kind === 'VACANCY')!;
    s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Работа с CRM', orderIndex: 99, sourceEvidence: 'CLIENT_BRIEF', sourceQuote: 'CRM обязательна', confirmedAt: new Date() });
    const trace2 = await s.postings.trace('u', rev.id);
    expect(trace2.items.find((i) => i.text === 'Работа с CRM')).toMatchObject({ origin: 'brief', label: 'из брифа', briefQuote: 'CRM обязательна', inText: true });
  });

  it('приёмка 31 (работодатель): пометка «добавлено HR»; publish-checklist ставит compliance и оплату первыми и не блокирует review', async () => {
    const s = setup(draftHandler);
    const e = seedAgency(s.prisma, 'EMPLOYER_HIRING');
    const rev = await s.postings.draftFromSheet('u', e.project.id);
    expect((await s.postings.trace('u', rev.id)).items[0].label).toBe('добавлено HR');
    await s.postings.check('u', rev.id);
    const checklist = await s.postings.publishChecklist('u', rev.id);
    expect(checklist.items.slice(0, 2).map((i) => i.key)).toEqual(['compliance', 'salary']);
    expect(checklist.open).toContain('compliance');
    expect(checklist.blocks).toBe(false);
    const reviewed = await s.postings.review('u', rev.id);
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
  });

  it('приёмка 30: варианты уникальны по (редакция, channel, lang); перевод несёт backCheck; новая редакция сбрасывает reviewedAt вариантов предыдущей', async () => {
    const s = setup(draftHandler);
    const a = seedAgency(s.prisma);
    const rev = await s.postings.draftFromSheet('u', a.project.id);
    await expect(s.postings.deriveVariants('u', rev.id, { channels: ['pdf'] })).rejects.toBeInstanceOf(BadRequestException);
    const variants = await s.postings.deriveVariants('u', rev.id, { channels: ['full', 'telegram'], langs: ['ru', 'en'] });
    expect(variants).toHaveLength(4);
    const en = variants.find((v) => v.lang === 'en' && v.channel === 'full')!;
    expect(en.backCheck).toEqual({ lost: ['Работа с CRM'], added: [] });
    expect(variants.find((v) => v.lang === 'ru' && v.channel === 'full')!.backCheck).toBeNull();
    // повторный вызов — те же четыре (upsert), не восемь
    await s.postings.deriveVariants('u', rev.id, { channels: ['full', 'telegram'], langs: ['ru', 'en'] });
    expect(s.prisma.rows('vacancyPostingVariant')).toHaveLength(4);
    await s.postings.reviewVariant('u', en.id);
    expect(s.prisma.rows('vacancyPostingVariant').find((v) => v.id === en.id)!.reviewedAt).toBeInstanceOf(Date);

    const rev2 = await s.postings.addRevision('u', a.project.id, TEXT + '\nP.S.');
    expect(s.prisma.rows('vacancyPostingVariant').every((v) => v.reviewedAt === null)).toBe(true);
    const checklist = await s.postings.publishChecklist('u', rev2.id);
    expect(checklist.open).toContain('variants');
    const view = await s.postings.get('u', a.project.id);
    expect(view!.journal[1].diff).toEqual({ added: ['P.S.'], removed: [] });
  });

  it('приёмка 44 / А-30: review-share только агентство (работодатель 404); публично — текст и происхождение без ComplianceFlag; комментарии', async () => {
    const s = setup(draftHandler);
    const e = seedAgency(s.prisma, 'EMPLOYER_HIRING');
    const revE = await s.postings.draftFromSheet('u', e.project.id);
    await expect(s.postings.createReviewShare('u', revE.id)).rejects.toBeInstanceOf(NotFoundException);

    const a = seedAgency(s.prisma);
    const rev = await s.postings.draftFromSheet('u', a.project.id);
    await s.postings.check('u', rev.id);
    const share = await s.postings.createReviewShare('u', rev.id);
    const view = await s.postings.publicReview(share.token);
    expect(view.text).toBe(TEXT);
    expect(JSON.stringify(view)).not.toMatch(/complianceFlag|Молодой коллектив.*alternativeText/);
    expect(view.origins.every((o) => o.label === 'добавлено агентством')).toBe(true);
    await s.postings.publicComment(share.token, 'Уберите «молодой коллектив»');
    expect((await s.postings.publicReview(share.token)).comments).toHaveLength(1);
    await expect(s.postings.publicReview('eng-internal-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});
