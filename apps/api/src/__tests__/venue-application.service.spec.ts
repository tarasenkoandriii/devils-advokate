import { VenueApplicationService } from '../venue-application/venue-application.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const users = new Map<string, any>();
  const applications: any[] = [];
  const approvedVenues: any[] = [];
  const bookingConfirmations: any[] = [];
  // Аудит 2026-09-03 (сверка доступа): ссылка на встречу из тела запроса
  // теперь проверяется на владение.
  const scheduledConversations: any[] = [];
  const placesSpend: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedUser(u: any) { users.set(u.id, { isVenueModerator: false, ...u }); },
    _seedApplication(a: any) { applications.push({ id: a.id ?? nextId(), status: 'PENDING', createdAt: new Date(), openingHours: [], photoReferences: [], ...a }); },
    _seedApprovedVenue(v: any) { approvedVenues.push({ id: v.id ?? nextId(), createdAt: new Date(), referralFeeAmount: null, isPriorityPartner: false, ...v }); },
    _getApplications() { return applications; },
    _getApprovedVenues() { return approvedVenues; },
    _getBookingConfirmations() { return bookingConfirmations; },
    _seedScheduledConversation(c: any) { scheduledConversations.push(c); },
    scheduledConversation: {
      findFirst: async ({ where }: any) =>
        scheduledConversations.find((c) => c.id === where.id && c.ownerId === where.project?.ownerId) ?? null,
    },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    // Пункт [the-priciest-door-had-no-lock] 2026-09-30: обращения к
    // платным картам считаются по журналу — фейк обязан уметь его
    // читать и писать, иначе потолок просто не выполнится.
    auditLogEntry: {
      count: async () => placesSpend.length,
      create: async ({ data }: any) => { placesSpend.push(data); return data; },
    },
    _placesSpend() { return placesSpend; },
    venueApplication: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), status: 'PENDING', createdAt: new Date(), ...data };
        applications.push(a);
        return a;
      },
      findUnique: async ({ where }: any) => applications.find((a) => a.id === where.id) ?? null,
      findMany: async ({ where }: any) => {
        let result = applications;
        if (where?.submittedByUserId !== undefined) result = result.filter((a) => a.submittedByUserId === where.submittedByUserId);
        if (where?.status !== undefined) result = result.filter((a) => a.status === where.status);
        return [...result].sort((a, b) => b.createdAt - a.createdAt);
      },
      update: async ({ where, data }: any) => {
        const idx = applications.findIndex((a) => a.id === where.id);
        applications[idx] = { ...applications[idx], ...data };
        return applications[idx];
      },
    },
    approvedVenue: {
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), ...data };
        approvedVenues.push(v);
        return v;
      },
      findMany: async () => [...approvedVenues].sort((a, b) => b.createdAt - a.createdAt),
      findUnique: async ({ where }: any) => approvedVenues.find((v) => v.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = approvedVenues.findIndex((v) => v.id === where.id);
        approvedVenues[idx] = { ...approvedVenues[idx], ...data };
        return approvedVenues[idx];
      },
    },
    venueBookingConfirmation: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), ...data };
        bookingConfirmations.push(c);
        return c;
      },
      findMany: async ({ where }: any) => bookingConfirmations.filter((c) => c.approvedVenueId === where.approvedVenueId),
      // Пункт [self-reported-money] 2026-09-05: одна отметка на человека
      // в день — фейк умеет findFirst с теми же условиями, иначе
      // проверка ограничения проверяла бы поведение фейка.
      findFirst: async ({ where }: any) =>
        bookingConfirmations.find(
          (c) =>
            c.approvedVenueId === where.approvedVenueId &&
            (where.confirmedByUserId === undefined || c.confirmedByUserId === where.confirmedByUserId) &&
            (!where.createdAt?.gte || c.createdAt >= where.createdAt.gte),
        ) ?? null,
    },
  };
}

function createFakeSecrets(apiKey = 'fake-places-key') {
  return { resolve: async () => apiKey };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

const USER_ID = 'user-1';
// Пункт [self-reported-money] 2026-09-05: второй обычный человек — для
// проверки, что ограничение «одна отметка в день» бьёт по повтору
// ОДНОГО, а не по тому, что в заведение сходили двое.
const OTHER_USER_ID = 'user-2';
const MODERATOR_ID = 'moderator-1';

function seedUsers(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedUser({ id: USER_ID });
  prisma._seedUser({ id: OTHER_USER_ID });
  prisma._seedUser({ id: MODERATOR_ID, isVenueModerator: true });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);
  const originalFetch = (global as any).fetch;

  test('searchCandidates() бросает BadRequestException для пустого запроса', async () => {
    const svc = new VenueApplicationService(createFakePrisma() as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.searchCandidates(USER_ID, '   '), BadRequestException, 'searchCandidates() с пустым запросом');
  });

  test('searchCandidates() бросает BadGatewayException при ошибке Google Places', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 403 });
    const svc = new VenueApplicationService(createFakePrisma() as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.searchCandidates(USER_ID, 'Кафе'), BadGatewayException, 'searchCandidates() при ошибке провайдера');
  });

  test('submitApplication() бросает BadRequestException без name/address', async () => {
    const svc = new VenueApplicationService(createFakePrisma() as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.submitApplication(USER_ID, { name: '', address: 'x' }), BadRequestException, 'submitApplication() без name');
  });

  test('submitApplication() создаёт заявку со статусом PENDING', async () => {
    const prisma = createFakePrisma();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const app = await svc.submitApplication(USER_ID, { name: 'Кафе Тихое', address: 'ул. Примерная, 1' });
    assertEqual(app.status, 'PENDING', 'заявка не публикуется автоматически');
    assertEqual(app.name, 'Кафе Тихое', 'название сохранено');
  });

  test('listPendingForModeration() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.listPendingForModeration(USER_ID), ForbiddenException, 'listPendingForModeration() без роли модератора');
  });

  test('moderate() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'x', address: 'x' });
    const [app] = prisma._getApplications();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.moderate(USER_ID, app.id, 'APPROVE'), ForbiddenException, 'moderate() без роли модератора');
  });

  test('moderate() REJECT не создаёт ApprovedVenue', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'x', address: 'x' });
    const [app] = prisma._getApplications();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const updated = await svc.moderate(MODERATOR_ID, app.id, 'REJECT');
    assertEqual(updated.status, 'REJECTED', 'статус изменён');
    assertEqual(prisma._getApprovedVenues().length, 0, 'публичная карточка не создана для отклонённой заявки');
  });

  test('регресійний тест (Пункт [audit-log]): moderate() REJECT РЕАЛЬНО викликає auditLog.record', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'x', address: 'x' });
    const [app] = prisma._getApplications();
    const recordedCalls: any[] = [];
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async (input: any) => { recordedCalls.push(input); return {}; } } as any);

    await svc.moderate(MODERATOR_ID, app.id, 'REJECT');

    assertEqual(recordedCalls.length, 1, 'auditLog.record викликаний рівно один раз');
    assertEqual(recordedCalls[0].action, 'venue_application.rejected', 'дію зафіксовано правильно');
  });

  test('регресійний тест (Пункт [audit-log]): moderate() APPROVE РЕАЛЬНО викликає auditLog.record, включно з referralFeeAmount', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'x', address: 'x', googlePlaceId: null });
    const [app] = prisma._getApplications();
    const recordedCalls: any[] = [];
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async (input: any) => { recordedCalls.push(input); return {}; } } as any);

    await svc.moderate(MODERATOR_ID, app.id, 'APPROVE', 500);

    assertEqual(recordedCalls.length, 1, 'auditLog.record викликаний рівно один раз');
    assertEqual(recordedCalls[0].action, 'venue_application.approved', 'дію зафіксовано правильно');
    assertEqual(recordedCalls[0].after.referralFeeAmount, 500, 'фінансово значуще рішення зафіксовано в after');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: moderate() APPROVE создаёт ApprovedVenue снапшотом, без googlePlaceId — rating остаётся null, не роняет одобрение', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'Кафе Тихое', address: 'ул. Примерная, 1', phone: '+7000', googlePlaceId: null });
    const [app] = prisma._getApplications();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const updated = await svc.moderate(MODERATOR_ID, app.id, 'APPROVE');
    assertEqual(updated.status, 'APPROVED', 'статус изменён');
    const venues = prisma._getApprovedVenues();
    assertEqual(venues.length, 1, 'публичная карточка создана');
    assertEqual(venues[0].name, 'Кафе Тихое', 'данные скопированы снапшотом');
    assertEqual(venues[0].rating, null, 'рейтинг честно null без googlePlaceId — не выдумывается');
  });

  test('moderate() бросает BadRequestException при повторной модерации уже обработанной заявки', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'x', address: 'x', status: 'APPROVED' });
    const [app] = prisma._getApplications();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.moderate(MODERATOR_ID, app.id, 'REJECT'), BadRequestException, 'moderate() на уже обработанную заявку');
  });

  test('moderate() бросает NotFoundException для несуществующей заявки', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.moderate(MODERATOR_ID, 'nonexistent', 'APPROVE'), NotFoundException, 'moderate() на несуществующую заявку');
  });

  test('listApprovedVenues()/getApprovedVenue() публично доступны без модератора', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApplication({ submittedByUserId: USER_ID, name: 'Кафе', address: 'x' });
    const [app] = prisma._getApplications();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await svc.moderate(MODERATOR_ID, app.id, 'APPROVE');

    const list = await svc.listApprovedVenues();
    assertEqual(list.length, 1, 'публичный список виден без роли модератора');
    const single = await svc.getApprovedVenue(list[0].id);
    assertEqual(single.name, 'Кафе', 'публичная карточка доступна по id');
  });

  test('getApprovedVenue() бросает NotFoundException для несуществующей карточки', async () => {
    const svc = new VenueApplicationService(createFakePrisma() as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.getApprovedVenue('nonexistent'), NotFoundException, 'getApprovedVenue() на несуществующую карточку');
  });

  // ── Пункт 67 (§3.22 "Монетизация") ──

  test('setReferralFee() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ name: 'x' });
    const [venue] = prisma._getApprovedVenues();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.setReferralFee(USER_ID, venue.id, 5), ForbiddenException, 'setReferralFee() без роли модератора');
  });

  test('setReferralFee() сохраняет сумму реферальной платы', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ name: 'x' });
    const [venue] = prisma._getApprovedVenues();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const updated = await svc.setReferralFee(MODERATOR_ID, venue.id, 5.5);
    assertEqual(updated.referralFeeAmount, 5.5, 'сумма сохранена');
  });

  test('setPriorityPartner() переключает флаг приоритетного размещения', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ name: 'x' });
    const [venue] = prisma._getApprovedVenues();
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const updated = await svc.setPriorityPartner(MODERATOR_ID, venue.id, true);
    assertEqual(updated.isPriorityPartner, true, 'флаг включён');
  });

  // ── Пункт [operator-money-untraced] 2026-09-24 ──
  //
  // Одобрение и отклонение заявки аудировались с самого начала (два
  // теста выше). Два других решения оператора по тому же заведению —
  // СУММА реферальной платы и ПОДЪЁМ над органической выдачей — следа
  // не оставляли. Из пяти операторских действий по заведениям без
  // аудита были ровно те, что про деньги и про место в выдаче.
  test('КЛЮЧЕВОЙ ТЕСТ [operator-money-untraced]: согласование платы пишется в журнал, со старым и новым значением', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ name: 'x', referralFeeAmount: 3 });
    const [venue] = prisma._getApprovedVenues();
    const recorded: any[] = [];
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async (r: any) => { recorded.push(r); return r; } } as any);

    await svc.setReferralFee(MODERATOR_ID, venue.id, 7.5);

    assertEqual(recorded.length, 1, 'запись ровно одна');
    assertEqual(recorded[0].action, 'approved_venue.referral_fee_set', 'действие названо');
    assertEqual(recorded[0].actorId, MODERATOR_ID, 'назван тот, кто решил');
    // Старое значение обязательно: «поставили 7.5» и «подняли с 3 до
    // 7.5» — разные сведения, и спор бывает ровно о втором.
    assertEqual(recorded[0].before.referralFeeAmount, 3, 'старое значение названо');
    assertEqual(recorded[0].after.referralFeeAmount, 7.5, 'новое значение названо');
  });

  test('КЛЮЧЕВОЙ ТЕСТ [operator-money-untraced]: подъём над органической выдачей пишется в журнал', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ name: 'x' });
    const [venue] = prisma._getApprovedVenues();
    const recorded: any[] = [];
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async (r: any) => { recorded.push(r); return r; } } as any);

    await svc.setPriorityPartner(MODERATOR_ID, venue.id, true);

    assertEqual(recorded.length, 1, 'запись ровно одна');
    assertEqual(recorded[0].action, 'approved_venue.priority_partner_set', 'действие названо');
    assertEqual(recorded[0].before.isPriorityPartner, false, 'прежнее состояние названо');
    assertEqual(recorded[0].after.isPriorityPartner, true, 'новое состояние названо');
  });

  test('confirmBooking() бросает NotFoundException для несуществующего заведения', async () => {
    const svc = new VenueApplicationService(createFakePrisma() as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.confirmBooking(USER_ID, 'nonexistent'), NotFoundException, 'confirmBooking() на несуществующее заведение');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: confirmBooking() фиксирует referralFeeOwed снапшотом на момент подтверждения, не пересчитывается позже', async () => {
    const prisma = createFakePrisma();
    prisma._seedApprovedVenue({ id: 'venue-1', name: 'Кафе', referralFeeAmount: 5 });
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const confirmation = await svc.confirmBooking(USER_ID, 'venue-1');
    assertEqual(confirmation.referralFeeOwed, 5, 'снапшот суммы на момент подтверждения');

    // Ставка поменялась ПОСЛЕ подтверждения — старая запись не должна измениться.
    prisma._getApprovedVenues()[0].referralFeeAmount = 100;
    assertEqual(prisma._getBookingConfirmations()[0].referralFeeOwed, 5, 'уже созданная запись не пересчиталась задним числом вслед за новой ставкой');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: чужую встречу нельзя привязать к своему подтверждению брони', async () => {
    const prisma = createFakePrisma();
    prisma._seedApprovedVenue({ id: 'venue-1', name: 'Кафе', referralFeeAmount: null });
    prisma._seedScheduledConversation({ id: 'sched-mine', ownerId: USER_ID });
    prisma._seedScheduledConversation({ id: 'sched-alien', ownerId: 'other-user' });
    const svc = new VenueApplicationService(prisma as any, {} as any, { record: async () => ({}) } as any);

    const ok = await svc.confirmBooking(USER_ID, 'venue-1', 'sched-mine');
    assertEqual(ok.scheduledConversationId, 'sched-mine', 'своя встреча привязывается');

    await assertThrowsAsync(
      () => svc.confirmBooking(USER_ID, 'venue-1', 'sched-alien'),
      NotFoundException,
      'чужая встреча в своём подтверждении',
    );
    assertEqual(prisma._getBookingConfirmations().length, 1, 'вторая строка не создана');
  });

  test('confirmBooking() честно сохраняет referralFeeOwed=null, если комиссия не согласована', async () => {
    const prisma = createFakePrisma();
    prisma._seedApprovedVenue({ id: 'venue-1', name: 'Кафе', referralFeeAmount: null });
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    const confirmation = await svc.confirmBooking(USER_ID, 'venue-1');
    assertEqual(confirmation.referralFeeOwed, null, 'честно null, не выдуманная сумма');
  });

  test('getCommissionSummary() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ id: 'venue-1', name: 'x' });
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);
    await assertThrowsAsync(() => svc.getCommissionSummary(USER_ID, 'venue-1'), ForbiddenException, 'getCommissionSummary() без роли модератора');
  });

  test('getCommissionSummary() суммирует подтверждённые брони и общую сумму к оплате', async () => {
    const prisma = createFakePrisma();
    seedUsers(prisma);
    prisma._seedApprovedVenue({ id: 'venue-1', name: 'Кафе', referralFeeAmount: 5 });
    const svc = new VenueApplicationService(prisma as any, createFakeSecrets() as any, { record: async () => ({}) } as any);

    // Пункт [self-reported-money] 2026-09-05: здесь один и тот же
    // человек отмечался дважды, и проверка требовала, чтобы обе отметки
    // легли в сумму. То есть тест ЗАКРЕПЛЯЛ находку: счётчик, которым
    // один человек может двигать деньги чужого заведения. Отметки теперь
    // от РАЗНЫХ людей — это и есть случай, ради которого сумма считается.
    await svc.confirmBooking(USER_ID, 'venue-1');
    await svc.confirmBooking(OTHER_USER_ID, 'venue-1');

    const summary = await svc.getCommissionSummary(MODERATOR_ID, 'venue-1');
    assertEqual(summary.totalBookingsConfirmed, 2, 'обе отметки учтены');
    assertEqual(summary.totalFeesOwed, 10, 'расчётная сумма = 5 + 5');
    assertEqual(summary.distinctReporters, 2, 'отметились двое разных людей');
    assertEqual(summary.basis, 'self-reported', 'происхождение чисел названо');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  (global as any).fetch = originalFetch;

  const failed = results.filter((r) => r.error);
  console.log(`\nVenueApplicationService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});
