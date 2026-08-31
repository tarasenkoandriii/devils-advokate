import { ConversationCardService } from '../conversation-card/conversation-card.service';
import { NotFoundException } from '@nestjs/common';

// Пункт 18: ConversationCardService теперь принимает DoNotSayService
// вторым аргументом (для selfRiskWarnings, §3.53 ТЗ) — фейк возвращает
// пустой список по умолчанию, не делает реальных вызовов.
const fakeDoNotSayService = { listForProject: async () => [] } as any;
// Пункт 22: третий аргумент — StaleFactService (для staleFacts, §3.57
// ТЗ), тот же принцип фейка.
const fakeStaleFactService = { listForProject: async () => [] } as any;
// Пункт 27/28: четвёртый и пятый аргументы — ConversationAgendaService
// и ProtectedNoteService (для agenda/protectedNotes, раздел 2 ТЗ),
// тот же принцип фейка.
const fakeAgendaService = { getLatest: async () => null } as any;
const fakeProtectedNoteService = { list: async () => [] } as any;

function createFakePrisma() {
  const projects = new Map<string, any>();
  const objectives = new Map<string, any>();
  const boundaries = new Map<string, any>();
  const args: any[] = [];
  const scripts: any[] = [];

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedObjective(projectId: string, obj: any) { objectives.set(projectId, obj); },
    _seedBoundaries(projectId: string, b: any) { boundaries.set(projectId, b); },
    _seedArgument(a: any) { args.push(a); },
    _seedScript(s: any) { scripts.push(s); },
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    negotiationBoundaries: {
      findUnique: async ({ where }: any) => boundaries.get(where.projectId) ?? null,
    },
    argument: {
      findMany: async ({ where, orderBy, take }: any) => {
        let items = args.filter((a) => a.projectId === where.projectId);
        if (orderBy?.weight === 'desc') {
          items = [...items].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
        }
        return take ? items.slice(0, take) : items;
      },
    },
    conversationScript: {
      findFirst: async ({ where }: any) => {
        const matches = scripts.filter((s) => s.projectId === where.projectId && s.type === where.type);
        return matches[matches.length - 1] ?? null; // последний засеянный — "самый свежий"
      },
    },
  };
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

describe('ConversationCardService', () => {
  it('спокойно деградирует, когда objective/boundaries ещё не заполнены', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Q', goal: null });
    const service = new ConversationCardService(prisma as any, fakeDoNotSayService, fakeStaleFactService, fakeAgendaService, fakeProtectedNoteService);

    const card = await service.get(USER_ID, PROJECT_ID);

    expect(card.objective).toBeNull();
    expect(card.boundaries).toBeNull();
    expect(card.doNotSay).toEqual([]);
    expect(card.openingScript).toBeNull();
    expect(card.closingScript).toBeNull();
  });

  it('собирает все секции, если данные заполнены', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли просить о повышении?', goal: 'Больше денег' });
    prisma._seedObjective(PROJECT_ID, { desiredOutcome: 'Повышение на 20%', doNotSay: ['Не упоминать прошлые конфликты'] });
    prisma._seedBoundaries(PROJECT_ID, { batna: 'Остаться как есть', walkAwayPoint: 'Отказ без объяснений' });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, text: 'Аргумент 1', weight: 0.9 });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, text: 'Аргумент 2', weight: 0.5 });

    const service = new ConversationCardService(prisma as any, fakeDoNotSayService, fakeStaleFactService, fakeAgendaService, fakeProtectedNoteService);
    const card = await service.get(USER_ID, PROJECT_ID);

    expect(card.objective!.desiredOutcome).toBe('Повышение на 20%');
    expect(card.boundaries!.batna).toBe('Остаться как есть');
    expect(card.doNotSay).toEqual(['Не упоминать прошлые конфликты']);
    expect(card.selfRiskWarnings).toEqual([]); // Пункт 18: AI-детекция отдельно от ручного doNotSay выше — здесь пусто, т.к. фейковый DoNotSayService возвращает []
    expect(card.staleFacts).toEqual([]); // Пункт 22: детерминированная выборка, здесь пусто, т.к. фейковый StaleFactService возвращает []
    expect(card.agenda).toEqual([]); // Пункт 27: фейковый ConversationAgendaService.getLatest() возвращает null -> []
    expect(card.protectedNotes).toEqual([]); // Пункт 28: фейковый ProtectedNoteService.list() возвращает []
    expect(card.topArguments.length).toBe(2);
    expect(card.topArguments[0].id).toBe('a1');
  });

  it('ограничивает topArguments лимитом (не более 5)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Q', goal: null });
    for (let i = 0; i < 8; i++) {
      prisma._seedArgument({ id: `a${i}`, projectId: PROJECT_ID, text: `Аргумент ${i}`, weight: i / 10 });
    }

    const service = new ConversationCardService(prisma as any, fakeDoNotSayService, fakeStaleFactService, fakeAgendaService, fakeProtectedNoteService);
    const card = await service.get(USER_ID, PROJECT_ID);

    expect(card.topArguments.length).toBe(5);
  });

  it('отклоняет чужой проект', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user', question: 'Q', goal: null });
    const service = new ConversationCardService(prisma as any, fakeDoNotSayService, fakeStaleFactService, fakeAgendaService, fakeProtectedNoteService);

    await expect(service.get(USER_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  // Фича 10 закрыла последнюю дыру — раньше openingScript/closingScript
  // были жёстко null, теперь читаются из реально сгенерированных
  // ConversationScript. Проверяем именно это, не полагаясь на старое
  // поведение по умолчанию.
  it('подставляет реальные скрипты открытия/закрытия, если они сгенерированы (фича 10)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Q', goal: null });
    prisma._seedScript({ projectId: PROJECT_ID, type: 'OPENING', text: 'Начнём с главного' });
    prisma._seedScript({ projectId: PROJECT_ID, type: 'CLOSING', text: 'Договорились, вернёмся через неделю' });

    const service = new ConversationCardService(prisma as any, fakeDoNotSayService, fakeStaleFactService, fakeAgendaService, fakeProtectedNoteService);
    const card = await service.get(USER_ID, PROJECT_ID);

    expect(card.openingScript).toBe('Начнём с главного');
    expect(card.closingScript).toBe('Договорились, вернёмся через неделю');
  });
});
