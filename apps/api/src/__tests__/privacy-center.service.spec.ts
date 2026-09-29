import { PrivacyCenterService } from '../privacy-center/privacy-center.service';
import { NotFoundException } from '@nestjs/common';
import { DEFAULT_PAGE_LIMIT } from '../common/page';

function createFakePrisma() {
  const consents: any[] = [];
  const projects: any[] = [];
  const people = new Map<string, any>();
  const personFacts: any[] = [];
  const projectPersonLinks: any[] = [];

  return {
    _seedConsent(c: any) { consents.push(c); },
    _seedProject(p: any) { projects.push(p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) { personFacts.push(f); },
    _seedProjectPersonLink(l: any) { projectPersonLinks.push(l); },
    _personExists(id: string) { return people.has(id); },
    _factsForPerson(personId: string) { return personFacts.filter((f) => f.personId === personId); },

    consentRecord: {
      findMany: async ({ where }: any) =>
        consents.filter((c) => c.userId === where.userId && (where.revokedAt === null ? c.revokedAt === null : true)),
    },
    // Аудит 2026-09-02 (продолжение): выгрузка стала полной — коллекции
    // пользовательского уровня. Содержимое здесь не проверяется, только
    // что они запрошены и попали в ответ.
    // Пункт [door-opened-onto-a-corner] 2026-09-25: область журнала решений
    // описана реестром, и он спрашивает записи человека у десяти моделей.
    // Здесь они отвечают пустотой — эта спека о полноте ВЫГРУЗКИ, а
    // полнота ОБЛАСТИ проверяется своей спекой.
    candidatePipelineStatus: { findMany: async () => [] },
    termsSheet: { findMany: async () => [] },
    offerDocument: { findMany: async () => [] },
    employerAgencyEngagement: { findMany: async () => [] },
    intakeSession: { findMany: async ({ where }: any) => (where.userId === 'user-1' ? [{ id: 'is-1' }] : []) },
    candidateProfile: { findMany: async ({ where }: any) => (where.ownerUserId === 'user-1' ? [{ id: 'cp-1' }] : []) },
    mediaReviewQueue: { findMany: async ({ where }: any) => (where.userId === 'user-1' ? [{ id: 'mq-1', items: [] }] : []) },
    safeShareAction: { findMany: async () => [] },
    // Пункт [export-user-scope] 2026-09-06: связи САМОГО аккаунта. Фейк
    // обязан их знать — иначе спек не заметил бы, что выгрузка их
    // запрашивает, и реестр снова стал бы декларацией.
    user: {
      findUnique: async ({ where, select }: any) => {
        if (where.id !== 'user-1') return null;
        const row: any = {
          id: 'user-1', telegramId: 'tg-1', createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-09-01T00:00:00Z'), languageCode: 'ru',
          privacyProcessingMode: 'BALANCED', launchDisclaimerAcknowledgedAt: null,
          launchDisclaimerVersion: null, religion: 'православие', city: 'Киев',
          country: 'Украина', countryCode: 'UA', ipCountryCode: 'PL',
          alwaysShowQuote: false, alwaysShowAnecdote: false,
          religiousReminderFrequency: 'ONCE_PER_DAY', religiousReminderLastShownAt: null,
          isLibraryModerator: false, isVenueModerator: false, isOperator: false,
          isRestricted: true, restrictedAt: new Date('2026-09-01T10:00:00Z'),
          restrictedNote: 'спам в публичном обсуждении',
          isBlocked: false, blockedAt: null, blockedNote: null,
        };
        if (!select) return row;
        const projected: any = {};
        for (const k of Object.keys(select)) projected[k] = row[k];
        return projected;
      },
    },
    libraryEntry: { findMany: async ({ where }: any) => (where.submittedByUserId === 'user-1' ? [{ id: 'le-1' }] : []) },
    venueApplication: { findMany: async ({ where }: any) => (where.submittedByUserId === 'user-1' ? [{ id: 'va-1' }] : []) },
    venueBookingConfirmation: { findMany: async ({ where }: any) => (where.confirmedByUserId === 'user-1' ? [{ id: 'vbc-1' }] : []) },
    candidateShare: {
      findMany: async ({ where, select }: any) => {
        if (where.sharedByUserId !== 'user-1') return [];
        const row: any = { id: 'cs-1', shareToken: 'СЕКРЕТ', batchToken: 'СЕКРЕТ-2', createdAt: new Date(), expiresAt: new Date(), acceptedAt: null, acceptedIntoMode: null, revokedAt: null, visibleClauseIds: [], consentSource: 'CANDIDATE_SELF', consentTextVersion: 'v3', sourceSheetId: 'sh-1' };
        if (!select) return [row];
        const projected: any = {};
        for (const k of Object.keys(select)) projected[k] = row[k];
        return [projected];
      },
    },
    voiceEmbedding: {
      findUnique: async ({ where, select }: any) => {
        if (where.userId !== 'user-1') return null;
        const row: any = { createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-05-01T00:00:00Z'), dimension: 192, embedding: [0.1, 0.2, 0.3] };
        if (!select) return row;
        const projected: any = {};
        for (const k of Object.keys(select)) projected[k] = row[k];
        return projected;
      },
    },
    // Пункт [audit-trail] 2026-09-04: решения, принятые О ЧЕЛОВЕКЕ, стали
    // разделом выгрузки. Фейк отдаёт одно ограничение аккаунта и одну
    // запись, где пользователь был АКТОРОМ, — вторая в выгрузку попасть
    // не должна (она про его действия, не про решения о нём).
    auditLogEntry: {
      findMany: async ({ where, select }: any) => {
        const rows = [
          {
            id: 'al-1',
            actorId: 'operator-1',
            action: 'user.restricted',
            resource: 'User',
            resourceId: 'user-1',
            before: { isRestricted: false, restrictedNote: null },
            after: { isRestricted: true, restrictedNote: 'спам в публичном обсуждении' },
            createdAt: new Date('2026-09-01T10:00:00Z'),
          },
          {
            id: 'al-2',
            actorId: 'user-1',
            action: 'library_entry.moderated',
            resource: 'LibraryEntry',
            resourceId: 'le-1',
            before: { status: 'PENDING' },
            after: { status: 'ACCEPTED' },
            createdAt: new Date('2026-09-02T10:00:00Z'),
          },
          // Пункт [decisions-spoke-machine] 2026-09-25: решение о
          // ПРОЕКТЕ человека — до этого пункта такие строки не
          // выгружались вовсе.
          {
            id: 'al-3',
            actorId: 'operator-1',
            action: 'project.frozen',
            resource: 'Project',
            resourceId: 'proj-1',
            before: { frozenAt: null },
            after: { frozenAt: '2026-09-03T10:00:00Z', frozenNote: 'жалоба второй стороны' },
            createdAt: new Date('2026-09-03T10:00:00Z'),
          },
          {
            id: 'al-4',
            actorId: 'operator-1',
            action: 'project.frozen',
            resource: 'Project',
            resourceId: 'proj-чужой',
            before: { frozenAt: null },
            after: { frozenAt: '2026-09-03T11:00:00Z' },
            createdAt: new Date('2026-09-03T11:00:00Z'),
          },
        ].filter((r) => {
          // Пункт [door-opened-onto-a-corner] 2026-09-25: условие строится
          // реестром областей и приходит списком `OR` из пар
          // «вид записи → идентификаторы человека». Прежний фейк знал
          // только форму с одним `resource`.
          const clauses: any[] = where.OR ?? [where];
          return clauses.some(
            (w) =>
              r.resource === w.resource &&
              (w.resourceId?.in ? w.resourceId.in.includes(r.resourceId) : r.resourceId === w.resourceId),
          );
        });
        if (!select) return rows;
        return rows.map((r) => {
          const projected: any = {};
          for (const key of Object.keys(select)) projected[key] = (r as any)[key];
          return projected;
        });
      },
    },
    project: {
      count: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId).length,
      findMany: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId),
    },
    person: {
      findMany: async ({ where }: any) => {
        return [...people.values()]
          .filter((p) => p.createdByUserId === where.createdByUserId)
          .map((p) => ({
            ...p,
            _count: {
              facts: personFacts.filter((f) => f.personId === p.id).length,
              projectLinks: projectPersonLinks.filter((l) => l.personId === p.id).length,
            },
            facts: personFacts.filter((f) => f.personId === p.id),
          }));
      },
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
      delete: async ({ where }: any) => {
        const p = people.get(where.id);
        people.delete(where.id);
        // Симулируем то же самое, что настоящий Postgres сделал бы
        // через onDelete: Cascade — но это ИМИТАЦИЯ, не проверка
        // реального каскада (тот подтверждён инспекцией schema.prisma,
        // не этим тестом).
        for (let i = personFacts.length - 1; i >= 0; i--) {
          if (personFacts[i].personId === where.id) personFacts.splice(i, 1);
        }
        for (let i = projectPersonLinks.length - 1; i >= 0; i--) {
          if (projectPersonLinks[i].personId === where.id) projectPersonLinks.splice(i, 1);
        }
        return p;
      },
    },
  };
}

const USER_ID = 'user-1';

describe('PrivacyCenterService', () => {
  it('getOverview() агрегирует согласия, число проектов и персон с их счётчиками', async () => {
    const prisma = createFakePrisma();
    prisma._seedConsent({ userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null });
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-2', ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Начальник Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1' });
    prisma._seedProjectPersonLink({ personId: 'person-1', projectId: 'proj-1' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }) } as any);
    const overview = await service.getOverview(USER_ID);

    expect(overview.projectsCount).toBe(2);
    expect(overview.people.length).toBe(1);
    expect(overview.people[0].factsCount).toBe(2);
    expect(overview.people[0].projectsCount).toBe(1);
    expect(overview.consents.length).toBe(1);
  });

  it('getOverview() не показывает персон/проекты других пользователей', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: 'other-user' });
    prisma._seedPerson({ id: 'person-1', createdByUserId: 'other-user', displayName: 'Чужой' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }) } as any);
    const overview = await service.getOverview(USER_ID);

    expect(overview.projectsCount).toBe(0);
    expect(overview.people.length).toBe(0);
  });

  it('deletePerson() полностью удаляет персону и её факты (не просто отвязывает)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Начальник Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }) } as any);
    await service.deletePerson(USER_ID, 'person-1');

    expect(prisma._personExists('person-1')).toBe(false);
    expect(prisma._factsForPerson('person-1').length).toBe(0);
  });

  it('deletePerson() отклоняет удаление чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: 'person-1', createdByUserId: 'other-user', displayName: 'Чужой' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }) } as any);
    await expect(service.deletePerson(USER_ID, 'person-1')).rejects.toThrow(NotFoundException);
    expect(prisma._personExists('person-1')).toBe(true);
  });

  it('exportData() собирает проекты, персон с фактами и согласия одного пользователя', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1', content: 'Факт' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }) } as any);
    const data = await service.exportData(USER_ID);

    expect(data.projects.length).toBe(1);
    expect(data.people.length).toBe(1);
    expect(data.people[0].facts.length).toBe(1);
    expect(data.consents.length).toBe(1);
    expect(typeof data.exportedAt).toBe('string');
  });

  // Пункт [ceiling-hid-inside-a-total] 2026-09-24. `takeWithProbe()`
  // берёт на строку БОЛЬШЕ потолка, чтобы узнать «есть ещё», и эта
  // строка обязана быть съедена `pagedList`. Здесь зонд вызывался, а
  // едока не было: в выгрузку уходило 201 решение, и о потолке не
  // говорилось нигде — в файле, чей ВЕСЬ смысл полнота и который
  // отдельным разделом называет каждое исключение по имени.
  it('КЛЮЧЕВОЙ ТЕСТ [decisions-spoke-machine]: решения о проектах человека выгружаются и объясняются словами', async () => {
    // До этого пункта раздел кончался на границе аккаунта: заморозку его
    // проекта оператором, разморозку и открытие карточки человек не мог
    // увидеть нигде — а именно этим файлом решение и оспаривают.
    const prisma = createFakePrisma();
    prisma.project.findMany = async ({ where, select }: any) => {
      if (where.ownerId !== USER_ID) return [];
      return select ? [{ id: 'proj-1' }] : [{ id: 'proj-1', ownerId: USER_ID }];
    };
    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({}) } as any);

    const data = await service.exportData(USER_ID);

    expect(data.projectDecisions).toHaveLength(1);
    const decision = data.projectDecisions[0];
    // Машинное имя осталось — по нему говорят с поддержкой…
    expect(decision.action).toBe('project.frozen');
    // …а рядом стои́т фраза, которую человек может прочитать.
    expect(decision.what).toContain('заморожен');
    expect(decision.by).toBe('оператор продукта');
    // Чужой проект в выгрузку не попадает: «решения о вас» — о ваших.
    expect(JSON.stringify(data.projectDecisions)).not.toContain('proj-чужой');
    // Свободная заметка оператора по-прежнему не отдаётся — это его
    // формулировка, а не факт о человеке (правило Пункта [audit-trail]).
    expect(JSON.stringify(data.projectDecisions)).not.toContain('жалоба второй стороны');

    // И решения об аккаунте тоже перестали быть машинными.
    expect(data.accountDecisions[0].what).not.toBe('user.restricted');
    expect(data.accountDecisions[0].what.length).toBeGreaterThan(15);

    // Пункт [door-opened-onto-a-corner] 2026-09-25. Строка о
    // рассмотренной заявке в библиотеку лежала в этом фейке с самого
    // начала, и до сегодня на неё никто не смотрел: область журнала
    // кончалась на аккаунте и проектах, и такие решения не доходили до
    // человека ни файлом, ни экраном. Мутация «потерять третью группу»
    // ничего не роняла именно поэтому.
    expect(data.belongingsDecisions).toHaveLength(1);
    expect(data.belongingsDecisions[0].action).toBe('library_entry.moderated');
    expect(data.belongingsDecisions[0].what).toContain('библиотеку');
    expect(data.belongingsDecisions[0].by).toBe('оператор продукта');
    // Граница области названа в файле, а не умолчана.
    expect(data.notIncluded.some((l: string) => l.includes('Не входят в разделы решений'))).toBe(true);
    expect(data.notIncluded.some((l: string) => l.includes('PromptVersion'))).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (Пункт [ceiling-hid-inside-a-total]): решений отдаётся не больше потолка, и о потолке сказано', async () => {
    const prisma = createFakePrisma();
    const many = Array.from({ length: DEFAULT_PAGE_LIMIT + 25 }, (_, i) => ({
      action: 'user.restricted',
      resource: 'User',
      resourceId: USER_ID,
      createdAt: new Date(2026, 0, 1 + (i % 28)),
    }));
    prisma.auditLogEntry.findMany = async ({ take }: any) => many.slice(0, take);
    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({}) } as any);

    const data = await service.exportData(USER_ID);

    expect(data.accountDecisions).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(
      data.notIncluded.some((line: string) => line.includes(`старше последних ${DEFAULT_PAGE_LIMIT}`)),
    ).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [decisions-spoke-machine]: у решений о проектах тот же потолок, и о нём сказано', async () => {
    // Раздел, который молча обрезается, отвечает на вопрос «мне отдали
    // всё?» неправдой — и тем вернее, что этим файлом спорят.
    const prisma = createFakePrisma();
    prisma.project.findMany = async ({ where, select }: any) => {
      if (where.ownerId !== USER_ID) return [];
      return select ? [{ id: 'proj-1' }] : [{ id: 'proj-1', ownerId: USER_ID }];
    };
    const many = Array.from({ length: DEFAULT_PAGE_LIMIT + 10 }, (_, i) => ({
      action: 'project.frozen',
      resource: 'Project',
      resourceId: 'proj-1',
      createdAt: new Date(2026, 0, 1 + (i % 28)),
    }));
    // Пункт [door-opened-onto-a-corner] 2026-09-25: вид записи приходит
    // внутри `OR`, построенного реестром областей.
    prisma.auditLogEntry.findMany = async ({ where, take }: any) =>
      (where.OR ?? [where]).some((w: any) => w.resource === 'Project') ? many.slice(0, take) : [];
    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({}) } as any);

    const data = await service.exportData(USER_ID);

    expect(data.projectDecisions).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(data.notIncluded.some((line: string) => line.includes('«projectDecisions»'))).toBe(true);
  });

  it('когда решений меньше потолка, лишней строки о потолке в выгрузке нет', async () => {
    const prisma = createFakePrisma();
    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({}) } as any);

    const data = await service.exportData(USER_ID);

    // Подпись, стоящая всегда, не отвечает на вопрос «мне отдали всё?».
    expect(data.notIncluded.some((line: string) => line.includes('старше последних'))).toBe(false);
  });

  it('РЕГРЕССИЯ (аудит 2026-09-02): «все мои данные» — не три коллекции: разговоры с транскриптами, спарринг, чаты, квиз, кандидаты, медиа входят; что не входит — названо', async () => {
    const prisma = createFakePrisma();
    let projectInclude: any = null;
    // Пункт [right-with-no-door] 2026-09-25: `project.findMany` зовётся
    // теперь дважды — выгрузкой с `include` и `readDecisions` с одним
    // `select: { id }`. Запоминается ИМЕННО запрос выгрузки, а не
    // последний по времени: иначе тест измеряет порядок вызовов.
    prisma.project.findMany = async ({ where, include }: any) => { if (include) projectInclude = include; return where.ownerId === USER_ID ? [{ id: 'proj-1' }] : []; };
    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { discardForUser: async () => ({}) } as any);
    const data = await service.exportData(USER_ID);

    // Ключи ответа — контракт полноты: новая коллекция без записи здесь
    // должна ронять тест, а не оставаться тихой неполнотой.
    expect(Object.keys(data).sort()).toEqual(
      [
        'accountDecisions',
        // Пункт [door-opened-onto-a-corner] 2026-09-25: решения о том, что
        // человеку ПРИНАДЛЕЖИТ — рассмотренная заявка, отозванное
        // согласие на передачу его данных, отозванный оффер. Прежняя
        // область журнала кончалась на аккаунте и проектах, и до человека
        // эти решения не доходили ни файлом, ни экраном.
        'belongingsDecisions',
        'candidateProfiles',
        'consents',
        'exportedAt',
        'intakeSessions',
        'mediaReviewQueues',
        'notIncluded',
        'people',
        // Пункт [decisions-spoke-machine] 2026-09-25: решения о
        // ПРОЕКТАХ человека — отдельный раздел; раньше их не было
        // нигде, потому что запрос отбирал только строки об аккаунте.
        'projectDecisions',
        'projects',
        'safeShareActions',
        // Пункт [export-user-scope] 2026-09-06 — связи самого аккаунта:
        // из шестнадцати в выгрузке были семь, и среди молчавших —
        // голосовой отпечаток.
        'profile',
        'libraryEntries',
        'venueApplications',
        'venueBookingConfirmations',
        'sentCandidateShares',
        'voicePrint',
      ].sort(),
    );
    // Внутри проекта — то, что человек продиктовал продукту.
    expect(projectInclude.conversations.include.transcript.include.segments).toBeTruthy();
    expect(projectInclude.sparringSessions.include.messages).toBeTruthy();
    expect(projectInclude.workingMaterials.include.chatSessions.include.messages).toBeTruthy();
    for (const key of ['protectedNotes', 'commitments', 'agendas', 'scheduledConversations', 'motiveHypotheses']) {
      expect(projectInclude[key]).toBe(true);
    }
    expect(data.intakeSessions).toHaveLength(1);
    expect(data.candidateProfiles).toHaveLength(1);
    // Пункт [audit-trail] 2026-09-04: раньше здесь проверялось, что
    // «аудит» упомянут среди НЕ включённого — и упоминание звучало как
    // «журнал служебный, без персональных данных». Это было неправдой:
    // журнал хранит решения, принятые об этом человеке. Теперь такие
    // решения выгружаются, а не включённой остаётся только рабочая
    // формулировка оператора — и именно она обязана быть названа.
    expect(data.notIncluded.some((line: string) => /заметки модератора/i.test(line))).toBe(true);

    /** КЛЮЧЕВЫЕ ТЕСТЫ [export-user-scope] 2026-09-06 — на ПОВЕДЕНИИ
     * выгрузки, а не на тексте её исходника. */
    // Голосовой отпечаток назван, но вектор в файл не уехал.
    expect(data.voicePrint).toMatchObject({ dimension: 192 });
    expect(JSON.stringify(data.voicePrint)).not.toContain('0.1');
    expect(data.notIncluded.some((l: string) => /биометрическ/i.test(l))).toBe(true);
    // Журнал передач есть, ключи в нём — нет.
    expect(data.sentCandidateShares).toHaveLength(1);
    expect(JSON.stringify(data.sentCandidateShares)).not.toContain('СЕКРЕТ');
    // Собственные ответы человека выгружаются, оценка оператора — нет.
    expect(data.profile).toMatchObject({ city: 'Киев', religion: 'православие' });
    expect(JSON.stringify(data.profile)).not.toContain('спам в публичном обсуждении');
    expect(JSON.stringify(data.profile)).not.toContain('PL'); // догадка о стране по адресу подключения
    // Тексты, написанные человеком в общие разделы.
    expect(data.libraryEntries).toHaveLength(1);
    expect(data.venueApplications).toHaveLength(1);
    expect(data.venueBookingConfirmations).toHaveLength(1);
  });
});
