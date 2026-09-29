// Сверка отзыва согласия 2026-09-04 — что он на самом деле отзывает.
//
// ПОЧЕМУ СЮДА. Предыдущие заходы проверяли удаление (аккаунта, проекта),
// выгрузку и журнал. Отзыв согласия — четвёртое действие того же ряда:
// человек нажимает кнопку, чтобы что-то прекратилось. Проверялось ли,
// что оно прекращается, — ни разу.
//
// НАЙДЕНО ДВА МЕСТА, ГДЕ ОТЗЫВ НЕ ОТЗЫВАЛ НИЧЕГО.
//
// 1. ГЛАВНОЕ — PUBLIC_SHARING. `enableSharing()` требует согласия перед
//    тем, как выдать `publicShareToken`. `publicView(token)` его больше
//    НИКОГДА не перепроверяет. Человек, нажавший «отозвать согласие на
//    публичный доступ», получал «готово» — и страница обсуждения
//    продолжала открываться у всех, кому он раньше дал ссылку. Причём
//    сам продукт уже описывал такое состояние в тексте ошибки
//    («обсуждение больше не публично доступно») — состояние, которого
//    отзыв согласия создать не мог.
//
// 2. VOICE_BIOMETRIC — «правило было, просто не везде», в самой чистой
//    форме. Правильный путь существует: `VoiceEmbeddingService.forget()`
//    удаляет вектор и только потом отзывает согласие. Но общий эндпоинт
//    `DELETE /consent/:type` — именно тот, которым человек пользуется в
//    Центре приватности, — звал `revoke()` напрямую, мимо удаления. Две
//    двери, правильная одна. И тип согласия здесь особый: его
//    формулировка — не «можно обрабатывать», а «можно ХРАНИТЬ постоянный
//    биометрический идентификатор». Отзыв разрешения на хранение,
//    оставляющий хранимое, — противоречие в определении.
//
// ТРЕТЬЕ, НЕ БАГ, НО ВАЖНЕЕ ОБОИХ. Для остальных одиннадцати типов
// «только на будущее» — правильное поведение, и менять его не нужно. Но
// ответ был `{ revoked: true }` и молчал об этом. Человек достраивает
// молчание в свою пользу: он читает «готово» как «всё, что собрано под
// этим согласием, удалено». Это зеркало формы, которую эти сверки
// разбирают с самого начала: не пробел выглядит как полнота, а
// БЕЗДЕЙСТВИЕ ВЫГЛЯДИТ КАК ДЕЙСТВИЕ. Теперь отзыв возвращает отчёт, и
// строка «что это НЕ отменяет» есть всегда — даже когда отзывать было
// нечего.
//
// НЕ СДЕЛАНО НАМЕРЕННО:
//  • отзыв LOCATION не стирает координаты, уже сохранённые в материалах
//    (геометка на фотографии с места ДТП): это часть доказательств
//    человека, и решение удалить их — его, по каждому файлу. Названо в
//    отчёте, а не сделано молча;
//  • отзыв CANDIDATE_DATA_TRANSFER не отзывает конкретные ссылки на
//    кандидатов: для этого есть отдельное действие в самой карточке, и
//    подменять одно другим значило бы делать за человека выбор, который
//    он не делал;
//  • отзыв EXTERNAL_AI не может отозвать то, что провайдер уже видел.
//    Это сказано прямо — соблазн промолчать здесь наибольший.

import { ConsentType } from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
import { REVOCATION_EFFECTS } from '../consent/consent-revocation-effects';

function makePrisma(seed: { projects?: any[]; embeddings?: any[]; records?: any[]; jobs?: any[] } = {}) {
  const projects = seed.projects ?? [];
  const embeddings = seed.embeddings ?? [];
  const records = seed.records ?? [];
  // Пункт [revoked-then-sent] 2026-09-06: заглушки этой модели не было
  // вовсе — отзыв согласия на внешний AI ничего не делал с задачами в
  // очереди, и проверять было нечего. Теперь делает.
  const jobs = seed.jobs ?? [];
  return {
    projects,
    embeddings,
    records,
    jobs,
    aIJob: {
      updateMany: async ({ where, data }: any) => {
        const hit = jobs.filter((j) => j.requestUserId === where.requestUserId && j.status === where.status);
        for (const j of hit) Object.assign(j, data);
        return { count: hit.length };
      },
    },
    consentRecord: {
      updateMany: async ({ where, data }: any) => {
        const hit = records.filter(
          (r) => r.userId === where.userId && r.consentType === where.consentType && r.revokedAt === null,
        );
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    project: {
      updateMany: async ({ where, data }: any) => {
        const hit = projects.filter((p) => p.ownerId === where.ownerId && p.publicShareToken !== null);
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
    },
    voiceEmbedding: {
      deleteMany: async ({ where }: any) => {
        const before = embeddings.length;
        for (let i = embeddings.length - 1; i >= 0; i--) {
          if (embeddings[i].userId === where.userId) embeddings.splice(i, 1);
        }
        return { count: before - embeddings.length };
      },
    },
  };
}

function activeRecord(consentType: ConsentType, userId = 'user-1') {
  return { userId, consentType, revokedAt: null, granted: true };
}

describe('Отзыв согласия: что он на самом деле отзывает', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: отзыв публичного доступа закрывает уже выданные ссылки', async () => {
    // До правки: токен оставался на месте, и страница открывалась у всех,
    // кому человек её отправил. «Отозвать» означало «пометить запись».
    const prisma = makePrisma({
      records: [activeRecord(ConsentType.PUBLIC_SHARING)],
      projects: [
        { id: 'p1', ownerId: 'user-1', publicShareToken: 'живая-ссылка' },
        { id: 'p2', ownerId: 'user-1', publicShareToken: null },
        { id: 'p3', ownerId: 'другой-человек', publicShareToken: 'чужая-ссылка' },
      ],
    });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.PUBLIC_SHARING);

    expect(prisma.projects[0].publicShareToken).toBeNull();
    expect(prisma.projects[2].publicShareToken).toBe('чужая-ссылка'); // чужое не трогаем
    expect(report.alsoDone).toHaveLength(1);
    expect(report.alsoDone[0]).toContain('ссылки');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отзыв согласия на голосовой отпечаток удаляет сам отпечаток', async () => {
    // Правильный путь в проекте был — VoiceEmbeddingService.forget().
    // Общий эндпоинт Центра приватности шёл мимо него.
    const prisma = makePrisma({
      records: [activeRecord(ConsentType.VOICE_BIOMETRIC)],
      embeddings: [{ userId: 'user-1' }, { userId: 'другой-человек' }],
    });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.VOICE_BIOMETRIC);

    expect(prisma.embeddings).toEqual([{ userId: 'другой-человек' }]);
    expect(report.alsoDone[0]).toContain('отпечаток');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отзыв, у которого нет последствий, честно говорит, чего он НЕ отменяет', async () => {
    // Десять типов из тринадцати — «только на будущее». Это верно и не
    // меняется; меняется то, что об этом теперь сказано. Пример взят
    // RECORDING вместо EXTERNAL_AI: последний с пункта
    // [revoked-then-sent] 2026-09-06 имеет последствие и для этой
    // проверки больше не годится — а сама проверка нужна по-прежнему.
    const prisma = makePrisma({ records: [activeRecord(ConsentType.RECORDING)] });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.RECORDING);

    expect(report.revoked).toBe(true);
    expect(report.alsoDone).toEqual([]);
    expect(report.doesNotUndo).toContain('расшифров');
    expect(report.doesNotUndo.length).toBeGreaterThan(40);
  });

  // ── Пункт [revoked-then-sent] 2026-09-06 ──
  it('КЛЮЧЕВОЙ ТЕСТ: отзыв согласия на внешний AI снимает задачи, ещё не отправленные провайдеру', async () => {
    const prisma = makePrisma({
      records: [activeRecord(ConsentType.EXTERNAL_AI)],
      jobs: [
        { id: 'j1', requestUserId: 'user-1', status: 'QUEUED', pendingRequest: { userId: 'user-1' } },
        { id: 'j2', requestUserId: 'user-1', status: 'RUNNING', externalInteractionId: 'ext-1' },
        { id: 'j3', requestUserId: 'другой-человек', status: 'QUEUED', pendingRequest: { userId: 'другой-человек' } },
      ],
    });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.EXTERNAL_AI);

    // Снята только та, что ещё не ушла никуда.
    expect(prisma.jobs.find((j: any) => j.id === 'j1').status).toBe('FAILED');
    expect(prisma.jobs.find((j: any) => j.id === 'j1').pendingRequest).toBeDefined();
    // RUNNING не трогаем: её содержимое провайдер уже видел, и делать
    // вид, что отмена что-то там отменяет, — та же неправда, только
    // наоборот.
    expect(prisma.jobs.find((j: any) => j.id === 'j2').status).toBe('RUNNING');
    // Чужие задачи — тем более.
    expect(prisma.jobs.find((j: any) => j.id === 'j3').status).toBe('QUEUED');

    expect(report.alsoDone).toHaveLength(1);
    expect(report.alsoDone[0]).toContain('очеред');
    // И то, чего отмена НЕ может, названо прямо.
    expect(report.doesNotUndo).toContain('дойдёт до него');
  });

  it('[revoked-then-sent]: снимать нечего — отчёт этого не выдумывает', async () => {
    const prisma = makePrisma({ records: [activeRecord(ConsentType.EXTERNAL_AI)] });
    const svc = new ConsentService(prisma as any);
    const report = await svc.revoke('user-1', ConsentType.EXTERNAL_AI);
    expect(report.revoked).toBe(true);
    expect(report.alsoDone).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «отозвано» и «отзывать было нечего» — разные ответы', async () => {
    // Прежний `{ revoked: true }` возвращался в обоих случаях. Человек,
    // отозвавший согласие дважды, второй раз получал такое же «готово».
    const prisma = makePrisma({ records: [] });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.RECORDING);

    expect(report.revoked).toBe(false);
    expect(report.recordsRevoked).toBe(0);
    // И граница отзыва названа даже здесь — она не зависит от того, было
    // ли что отзывать.
    expect(report.doesNotUndo.length).toBeGreaterThan(0);
  });

  it('«ничего не удалили» не выдаётся за «удалили»: пустой результат не попадает в alsoDone', async () => {
    // У человека нет ни одной открытой ссылки. Отчёт не должен сообщать
    // «ссылки закрыты» — это было бы тем же преувеличением, только в
    // новой обёртке.
    const prisma = makePrisma({
      records: [activeRecord(ConsentType.PUBLIC_SHARING)],
      projects: [{ id: 'p1', ownerId: 'user-1', publicShareToken: null }],
    });
    const svc = new ConsentService(prisma as any);

    const report = await svc.revoke('user-1', ConsentType.PUBLIC_SHARING);

    expect(report.alsoDone).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у КАЖДОГО типа согласия сказано, чего отзыв не отменяет', () => {
    // Реестр обязан покрывать enum целиком: новый тип согласия без
    // записи здесь означал бы, что отзыв снова отвечает молча.
    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): раньше
    // здесь стояла только длина, и мутация «заменить объяснение пустой
    // формулой» («Ничего дополнительно не отменяется этим действием»)
    // её проходила. Формула длиннее тридцати символов и сообщает ровно
    // столько же, сколько молчание, которое этот заход и убирал.
    //
    // ЧЕСТНАЯ ГРАНИЦА: качество текста тестом не проверить — можно
    // проверить только его отсутствие. Ниже — список формул, которые
    // ничего не говорят; остальное на совести пишущего.
    const EMPTY_FORMULAS = /^(ничего|нет|не применимо|отзыв ничего)/i;
    const missing = Object.values(ConsentType).filter((type) => {
      const effect = REVOCATION_EFFECTS[type];
      if (!effect || !effect.doesNotUndo) return true;
      if (effect.doesNotUndo.length < 60) return true;
      return EMPTY_FORMULAS.test(effect.doesNotUndo.trim());
    });
    expect(missing).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько типов согласия имеют последствия сверх пометки', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Если
    // типов с последствиями станет больше, а кода — нет, это заметно.
    const withEffects = Object.values(ConsentType).filter((t) => REVOCATION_EFFECTS[t].alsoDoes !== null);
    // Стало три. Третий — EXTERNAL_AI, пункт [revoked-then-sent]
    // 2026-09-06: отзыв обещал «новых запросов от вашего имени больше не
    // будет» и при этом не трогал задачи, уже стоявшие в очереди.
    // Измерение обновлено вместе с кодом, а не подогнано под него: рост
    // здесь и должен означать, что найдено ещё одно бездействие,
    // выдававшее себя за действие.
    expect(withEffects.sort()).toEqual([ConsentType.EXTERNAL_AI, ConsentType.PUBLIC_SHARING, ConsentType.VOICE_BIOMETRIC].sort());
    expect(Object.keys(REVOCATION_EFFECTS)).toHaveLength(Object.values(ConsentType).length);
  });
});
