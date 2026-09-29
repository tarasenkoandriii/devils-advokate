// Пункт [job-domain-v2] — приёмка 17, 34–38 (бриф, компания, представитель, чеклист).
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { isRegistryUrl, looksLikePersonName, extractDomain, loadRegistryHosts, DEFAULT_REGISTRY_HOSTS } from '../employer-dossier/registry-hosts';
import { ClientBriefService, BRIEF_COMPLIANCE_PROMPT } from '../client-brief/client-brief.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

// Сеть в спеке — только через этот перехватчик: refresh обязан ходить лишь по
// шаблонам реестров, и тест проверяет список запрошенных URL.
const fetched: string[] = [];
jest.mock('../common/safe-url-fetch', () => {
  const actual = jest.requireActual('../common/safe-url-fetch');
  return {
    ...actual,
    // Пункт [stored-text-cut] 2026-09-06: загрузчик отдаёт текст ВМЕСТЕ
    // с отчётом о том, сколько его вошло. Заглушка знает ту же форму —
    // иначе спек проверял бы не то, что вызывается.
    fetchUrlText: async (url: string) => {
      fetched.push(url);
      const page = 'ТОВ РОМАШКА. Стан: зареєстровано. Керівник: Петренко Іван Іванович. КВЕД 62.01.';
      return { text: page, intake: { used: page.length, total: page.length, limit: 12_000 } };
    },
  };
});

function setup(handler: (req: any) => string = () => '{}') {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const audit = { records: [] as any[], record: async (r: any) => { audit.records.push(r); return r; } };
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const dossiers = new EmployerDossierService(prisma as any, router as any, audit as any);
  const briefs = new ClientBriefService(prisma as any, router as any, sheets, matching);
  return { prisma, router, audit, sheets, dossiers, briefs };
}

describe('registry-hosts — конфигурация реестров', () => {
  it('дефолт — Украина; юрисдикция вне списка пуста; конфиг из env перекрывает', () => {
    expect(loadRegistryHosts({}).UA.length).toBeGreaterThan(0);
    expect(loadRegistryHosts({}).EU).toBeUndefined();
    expect(loadRegistryHosts({ EMPLOYER_REGISTRY_HOSTS: '{"EE":[{"host":"ariregister.rik.ee","category":"REGISTRY"}]}' }).EE[0].host).toBe('ariregister.rik.ee');
    expect(loadRegistryHosts({ EMPLOYER_REGISTRY_HOSTS: 'не json' })).toBe(DEFAULT_REGISTRY_HOSTS);
  });
  it('isRegistryUrl — хост реестра или поддомен; чужой хост — null', () => {
    expect(isRegistryUrl('https://usr.minjust.gov.ua/content/free-search', 'UA')?.category).toBe('REGISTRY');
    expect(isRegistryUrl('https://www.reyestr.court.gov.ua/Review/1', 'UA')?.category).toBe('COURT');
    expect(isRegistryUrl('https://company.example/about', 'UA')).toBeNull();
    expect(isRegistryUrl('https://usr.minjust.gov.ua/x', 'EE')).toBeNull();
  });
  it('looksLikePersonName / extractDomain', () => {
    expect(looksLikePersonName('Іван Петренко')).toBe(true);
    expect(looksLikePersonName('ТОВ Ромашка')).toBe(false);
    expect(looksLikePersonName('Acme Studio')).toBe(false);
    expect(looksLikePersonName('Ромашка')).toBe(false);
    expect(extractDomain('hr@Company.com')).toBe('company.com');
    expect(extractDomain('https://www.company.com/jobs')).toBe('company.com');
  });
});

describe('EmployerDossierService', () => {
  it('приёмка 37: identify без сети; имя физлица без компании → 400; дубль по домену до кода → 409; код объединяет досье; refresh без кода/домена → 400', async () => {
    const { prisma, dossiers, router } = setup();
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    await expect(dossiers.identify('u1', project.id, { legalName: 'Іван Петренко' })).rejects.toThrow(/Укажите компанию/);
    await expect(dossiers.identify('u1', project.id, {})).rejects.toBeInstanceOf(BadRequestException);
    const d1 = await dossiers.identify('u1', project.id, { domain: 'www.Romashka.ua' });
    expect(d1.domain).toBe('romashka.ua');
    expect(d1.legalName).toBeNull();
    await expect(dossiers.identify('u1', project.id, { domain: 'romashka.ua' })).rejects.toBeInstanceOf(ConflictException);
    const merged = await dossiers.identify('u1', project.id, { domain: 'romashka.ua', registryCode: '12345678', legalName: 'ТОВ Ромашка' });
    expect(merged.id).toBe(d1.id);
    expect(merged.registryCode).toBe('12345678');
    await expect(dossiers.identify('u1', project.id, { registryCode: '12345678' })).rejects.toBeInstanceOf(ConflictException);
    expect(router.calls).toHaveLength(0); // identify — без единого AI-вызова
    const d2 = await dossiers.identify('u1', project.id, { legalName: 'ТОВ Без Кода', domain: 'bezkoda.ua' });
    await expect(dossiers.refresh('u1', d2.id)).rejects.toThrow(/Укажите компанию/);
  });

  // ── Пункт [same-answer-either-way] 2026-09-24 ──
  //
  // Здесь замысел ОБРАТЕН идемпотентному: повтор — ошибка, и о ней
  // сказано внятно, с `existingDossierId`, чтобы человек мог открыть уже
  // созданное. Но проверка на дубль и вставка разделены во времени, и
  // второй такой же вызов проскакивал проверку — дальше
  // `@@unique([projectId, registryCode])` отвергал вставку, и вместо
  // внятного «досье уже есть» человек получал пятисотку.
  //
  // Гонку не исключаем — проверяем, что её ИСХОД ОДИН И ТОТ ЖЕ.
  it('КЛЮЧЕВОЙ ТЕСТ [same-answer-either-way]: проигравший гонку читает «уже есть», а не «внутренняя ошибка»', async () => {
    const { prisma, dossiers } = setup();
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const первое = await dossiers.identify('u1', project.id, { registryCode: '99999999', legalName: 'ТОВ Гонка' });

    // Перехват через defineProperty: фейковая Prisma — Proxy, собирающий
    // делегат заново на каждом обращении, и обычное присваивание поля
    // молча пропадает (тест выглядел бы рабочим, ничего не проверяя).
    const делегат = prisma.employerDossier;
    let бросили = false;
    Object.defineProperty(prisma, 'employerDossier', {
      configurable: true,
      value: {
        ...делегат,
        // конкурент успел записать: проверка на дубль ничего не нашла,
        // а база вставку уже не примет
        findFirst: async (args: any) => (бросили ? делегат.findFirst(args) : null),
        create: async () => {
          бросили = true;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
      },
    });

    const err = await dossiers.identify('u1', project.id, { registryCode: '99999999', legalName: 'ТОВ Гонка' }).catch((e) => e);
    delete (prisma as any).employerDossier;

    expect(бросили).toBe(true); // перехват сработал, иначе тест пуст
    expect(err).toBeInstanceOf(ConflictException);
    // И главное: ответ ТОТ ЖЕ, что у проверки выше, — с id уже созданного.
    expect((err as ConflictException).getResponse()).toMatchObject({
      message: 'Досье на эту компанию в проекте уже есть',
      existingDossierId: первое.id,
    });
  });

  it('приёмка 35/36: факты — только реестры или ссылка пользователя; REVIEWS без цитаты; сайт компании — не источник; refresh не ходит на домен компании и ≤ 1/сутки', async () => {
    fetched.length = 0;
    {
      const { prisma, dossiers, router } = setup(() => JSON.stringify({ facts: [{ category: 'REGISTRY', quote: 'Стан: зареєстровано' }, { category: 'REGISTRY', quote: 'Керівник: Петренко Іван Іванович' }, { category: 'OTHER', quote: 'этого на странице нет' }] }));
      const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
      const d = await dossiers.identify('u1', project.id, { registryCode: '12345678', domain: 'romashka.ua', legalName: 'ТОВ Ромашка' });

      await expect(dossiers.addUserSource('u1', d.id, { url: 'https://romashka.ua/about' })).rejects.toThrow(/Сайт самой компании/);
      const review = await dossiers.addUserSource('u1', d.id, { url: 'https://dou.ua/companies/romashka/reviews/' });
      expect(review.category).toBe('REVIEWS');
      expect(review.quote).toBeNull();

      const report = await dossiers.refresh('u1', d.id, new Date('2026-09-02T10:00:00Z'));
      const templates = DEFAULT_REGISTRY_HOSTS.UA.filter((h) => h.urlTemplate).length;
      expect(fetched).toHaveLength(templates);
      expect(report.factsAdded).toBe(2 * templates); // третий факт с каждой страницы — цитата не из страницы
      // [dropped-quotes] 2026-09-04: и этот третий теперь НАЗВАН. Отчёт
      // перечислял три вида отбрасывания из четырёх, а четвёртый молчал —
      // отчёт, который называет не все, хуже отчёта, который не называет
      // ни одного: он выглядит полным.
      expect(report.skippedWithoutQuote).toBe(templates);
      expect(fetched.every((u) => !u.includes('romashka.ua'))).toBe(true); // ни одного запроса к домену компании
      expect(fetched.every((u) => !u.includes('dou.ua'))).toBe(true); // отзывы не загружаются
      expect(fetched.every((u) => u.includes('12345678'))).toBe(true); // только шаблоны реестров по коду
      expect(fetched.every((u) => !u.toLowerCase().includes('петренко'))).toBe(true); // имени представителя в запросах нет
      expect(router.calls.every((c) => c.taskType === 'employer-dossier-extract')).toBe(true);

      await expect(dossiers.refresh('u1', d.id, new Date('2026-09-02T20:00:00Z'))).rejects.toMatchObject({ status: 429 });

      const view = await dossiers.get('u1', d.id);
      expect(view.facts.every((f) => f.sourceUrl && f.fetchedAt)).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/"(score|rating|risk|index)"/);
      // assertFactAllowed — детерминированная проверка формы факта
      const dossierMeta = { jurisdiction: 'UA', domain: 'romashka.ua' };
      expect(() => dossiers.assertFactAllowed(dossierMeta, { category: 'REVIEWS' as any, quote: 'пересказ отзыва', sourceUrl: 'https://dou.ua/x', fetchedAt: new Date() }, new Set(['https://dou.ua/x']))).toThrow(/только ссылкой/);
      expect(() => dossiers.assertFactAllowed(dossierMeta, { category: 'OTHER' as any, quote: 'q', sourceUrl: 'https://random.site/x', fetchedAt: new Date() }, new Set())).toThrow(/олько открытые источники или ваша ссылка/);
      expect(() => dossiers.assertFactAllowed(dossierMeta, { category: 'REGISTRY' as any, quote: 'q', sourceUrl: 'https://usr.minjust.gov.ua/x', fetchedAt: null }, new Set())).toThrow(/fetchedAt/);
    }
  });

  it('приёмка 36: проверка представителя — без сети: домен + факты реестра; NOT_CONFIRMED при чужом домене; CONFIRMED_PUBLIC только с checkSourceUrl реестра', async () => {
    const { prisma, dossiers, router } = setup();
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const d = await dossiers.identify('u1', project.id, { registryCode: '12345678', domain: 'romashka.ua', legalName: 'ТОВ Ромашка' });
    prisma.seed('employerDossierFact', { dossierId: d.id, category: 'REGISTRY', quote: 'Керівник: Петренко Іван Іванович', sourceUrl: 'https://opendatabot.ua/c/12345678', fetchedAt: new Date() });

    const hr = await dossiers.addRepresentative('u1', d.id, { displayName: 'Марія', claimedRole: 'HR', contactDomain: 'maria@romashka.ua' });
    expect(hr.check).toBe('CONFIRMED_PUBLIC');
    expect(hr.checkSourceUrl).toContain('opendatabot.ua');
    const stranger = await dossiers.addRepresentative('u1', d.id, { displayName: 'Олег', claimedRole: 'рекрутер', contactDomain: 'oleg@gmail.com' });
    expect(stranger.check).toBe('NOT_CONFIRMED');
    const director = await dossiers.addRepresentative('u1', d.id, { displayName: 'Петренко Іван Іванович', claimedRole: 'директор' });
    expect(director.check).toBe('CONFIRMED_PUBLIC');
    const fakeDirector = await dossiers.addRepresentative('u1', d.id, { displayName: 'Сидоренко Петро', claimedRole: 'директор' });
    expect(fakeDirector.check).toBe('NOT_CONFIRMED');
    const asStated = await dossiers.addRepresentative('u1', d.id, { displayName: 'Аня', claimedRole: null });
    expect(asStated.check).toBe('AS_STATED');
    expect(router.calls).toHaveLength(0); // ни одного AI-вызова и ни одного fetch
    // связать с Person может только соискатель
    await expect(dossiers.addRepresentative('u1', d.id, { displayName: 'X', personId: 'p1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('приёмка 38 / 44: чеклист отправки — только агентство (у работодателя 404); не закрывается без кода/домена; открытый пункт пишется в аудит', async () => {
    const { prisma, dossiers, audit } = setup();
    const employer = prisma.seed('project', { ownerId: 'u1', mode: 'EMPLOYER_HIRING' });
    await expect(dossiers.shipmentChecklist('u1', employer.id)).rejects.toBeInstanceOf(NotFoundException);
    const agency = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const empty = await dossiers.shipmentChecklist('u1', agency.id);
    expect(empty.closable).toBe(false);
    expect(empty.open).toContain('companyIdentified');
    await dossiers.identify('u1', agency.id, { registryCode: '12345678' });
    const withCode = await dossiers.shipmentChecklist('u1', agency.id);
    expect(withCode.open).not.toContain('companyIdentified');
    expect(withCode.open).toContain('registryFact');
    const result = await dossiers.auditShipment('u1', agency.id, 'candidate_share.created', 'share-1');
    expect(result!.open.length).toBeGreaterThan(0);
    expect(audit.records[0]).toMatchObject({ resource: 'ShipmentChecklist', after: { openItems: expect.arrayContaining(['registryFact']) } });
    // у работодателя auditShipment — null, без ошибки
    expect(await dossiers.auditShipment('u1', employer.id, 'x', 'y')).toBeNull();
  });
});

describe('ClientBriefService', () => {
  const brief = 'Нужен продажник в B2B, зарплата обсуждается. Желательно женщину до 35 без маленьких детей. Формат — удалёнка, но офис обязателен по понедельникам.';

  it('приёмка 17: у работодателя бриф до идентификации компании → 409 «укажите компанию»; после — конфиг создаётся пустым вместе с брифом', async () => {
    const { prisma, briefs, dossiers } = setup();
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'EMPLOYER_HIRING' });
    await expect(briefs.ingest('u1', project.id, { rawText: brief })).rejects.toMatchObject({ response: { code: 'COMPANY_REQUIRED' } });
    await dossiers.identify('u1', project.id, { registryCode: '12345678', legalName: 'ТОВ Ромашка' });
    const b = await briefs.ingest('u1', project.id, { rawText: brief, source: 'со слов менеджера' });
    expect(b.origin).toBe('INTERNAL');
    expect(prisma.rows('interviewPoolConfig').find((c) => c.projectId === project.id)).toMatchObject({ jobTitle: '' });
    // у соискателя бриф не принимается
    const js = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    await expect(briefs.ingest('u1', js.id, { rawText: brief })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('приёмка 34/29: extract → черновики пунктов VACANCY-листа с цитатой-подстрокой брифа; цитата не из брифа отбрасывается; описание конфига предзаполняется', async () => {
    const { prisma, briefs } = setup((req) =>
      req.taskType === 'terms-clauses-extract'
        ? JSON.stringify({
            clauses: [
              { kind: 'REQUIREMENT', text: 'Опыт B2B-продаж', category: 'роль', isRequired: true, quote: 'продажник в B2B' },
              { kind: 'CONDITION', text: 'Удалёнка с офисом по понедельникам', category: 'условия', isRequired: false, quote: 'Формат — удалёнка, но офис обязателен по понедельникам' },
              { kind: 'CONDITION', text: 'Зарплата 5000', category: 'оплата', isRequired: false, quote: 'зарплата 5000' },
            ],
          })
        : '{}',
    );
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const b = await briefs.ingest('u1', project.id, { rawText: brief });
    expect(b.origin).toBe('EXTERNAL');
    const res = await briefs.extract('u1', b.id);
    expect(res.proposedClauses).toHaveLength(2);
    expect(res.proposedClauses.every((c) => c.confirmedAt === null && c.sourceEvidence === 'CLIENT_BRIEF' && c.sourceRef === b.id)).toBe(true);
    expect(res.proposedClauses.every((c) => brief.includes(c.sourceQuote!))).toBe(true);
    expect(prisma.rows('interviewPoolConfig')[0].extendedDescription).toBe(brief);
    expect(prisma.rows('termsSheet')[0]).toMatchObject({ kind: 'VACANCY', projectId: project.id });
  });

  it('А-24: compliance брифа — ComplianceFlag(clientBriefId) с цитатой и деловой альтернативой; без номеров норм в промпте; дубли не плодятся', async () => {
    const { prisma, briefs } = setup(() => JSON.stringify({ flags: [{ category: 'пол/возраст/дети', quotedText: 'женщину до 35 без маленьких детей', alternativeText: 'готовность к командировкам' }, { category: 'x', quotedText: 'нет в брифе', alternativeText: 'y' }] }));
    expect(BRIEF_COMPLIANCE_PROMPT).not.toMatch(/24¹|2023\/970|стать/);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const b = await briefs.ingest('u1', project.id, { rawText: brief });
    const { complianceFlags: flags, skippedWithoutQuote } = await briefs.complianceScan('u1', b.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ clientBriefId: b.id, quotedText: 'женщину до 35 без маленьких детей', alternativeText: 'готовность к командировкам' });
    expect(flags[0].configId).toBeTruthy();
    // [dropped-quotes] 2026-09-04: второй флаг («нет в брифе») отброшен
    // правильно — но раньше он исчезал бесследно, и человек читал под
    // списком «Compliance-флагов нет». Число делает потерю видимой.
    expect(skippedWithoutQuote).toBe(1);
    expect((await briefs.complianceScan('u1', b.id)).complianceFlags).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [one-of-several-spoke-for-all]: два заказчика в проекте — «их несколько», а не «сравнивать не с чем»', async () => {
    // Раньше бралось одно досье из нескольких, и весь разбор молча шёл
    // про произвольно выбранного заказчика. Две разные новости —
    // «компания не определена» и «компаний несколько» — не должны
    // выглядеть одинаково: во втором случае человеку есть что сделать.
    const { prisma, briefs } = setup(() => JSON.stringify({ clauses: [] }));
    const p = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    prisma.seed('employerDossier', { projectId: p.id, legalName: 'ТОВ Ромашка', registryCode: '111', jurisdiction: 'UA' });
    prisma.seed('employerDossier', { projectId: p.id, legalName: 'ТОВ Василёк', registryCode: '222', jurisdiction: 'UA' });

    const res = await briefs.diffAgainstPrevious('u1', p.id);
    expect(res.comparable).toBe(false);
    expect(res.reason).toContain('ТОВ Ромашка');
    expect(res.reason).toContain('ТОВ Василёк');
    expect(res.reason).not.toContain('сравнивать не с чем');
  });

  it('А-29: диф брифов — только агентство (работодатель 404); без кода реестра — «не с чем»; по коду — added/removed детерминированно', async () => {
    const { prisma, briefs, dossiers, sheets } = setup(() => JSON.stringify({ clauses: [] }));
    const employer = prisma.seed('project', { ownerId: 'u1', mode: 'EMPLOYER_HIRING' });
    await expect(briefs.diffAgainstPrevious('u1', employer.id)).rejects.toBeInstanceOf(NotFoundException);

    const p1 = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const p2 = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    expect((await briefs.diffAgainstPrevious('u1', p2.id)).comparable).toBe(false);
    await dossiers.identify('u1', p1.id, { registryCode: '12345678' });
    await dossiers.identify('u1', p2.id, { registryCode: '12345678' });
    for (const [p, texts] of [[p1, ['Опыт B2B', 'Английский']], [p2, ['Опыт B2B', 'Немецкий']]] as const) {
      const b = await briefs.ingest('u1', p.id, { rawText: 'бриф' });
      const sheet = await sheets.ensureVacancySheet('u1', p.id);
      for (const t of texts) prisma.seed('termsClause', { sheetId: sheet!.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: t, orderIndex: 0, sourceEvidence: 'CLIENT_BRIEF', sourceRef: b.id, confirmedAt: new Date() });
    }
    const diff = await briefs.diffAgainstPrevious('u1', p2.id);
    expect(diff).toMatchObject({ comparable: true, added: ['Немецкий'], removed: ['Английский'] });
  });
});
