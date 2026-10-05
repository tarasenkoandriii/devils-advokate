// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.6/§4.4):
// кандидати + обмін через Telegram.
//
// АУДИТ ПЕРЕД РЕАЛІЗАЦІЄЮ (див. коментар над CandidateShare у schema.prisma):
// перша версія ТЗ описувала пакетний шеринг як "масив sourceCandidateId
// замість одного" — математично неможливо в самій же схемі документа
// (sourceCandidateId скалярне, shareToken @unique). Виправлено:
// shareToken (одиночний) і batchToken (пакетний, НЕ unique — кілька
// рядків з однаковим значенням і є сам механізм пакета) — окремі поля.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { termIsCurrent, TERM_OVER_MESSAGE } from '../common/term-validity';
import { randomBytes } from 'crypto';
import { CandidateStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { safeSecretEqual } from '../common/timing-safe-equal';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';
import { revokeConsentCascade, CONSENT_REVOKED_MESSAGE } from './consent-revocation';
import { CANDIDATE_REVOCATION_EFFECTS, revocationAlsoDone, revocationDoesNotUndo } from './revocation-report';
import { buildStartDeepLink } from '../common/telegram-deep-link';

const SHARE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // §4.6 ТЗ: "за замовчуванням 72 години"

@Injectable()
export class InterviewPoolCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    // Приёмка 38 [job-domain-v2]: открытый пункт чеклиста отправки не
    // блокирует шеринг, но обязан попасть в аудит. Аудит 2026-09-03
    // нашёл, что auditShipment() не вызывался ни одним путём отправки —
    // правило существовало только в тесте самой функции. Необязательная
    // зависимость: у пулов без досье компании (и в старых тестах)
    // сервис работает как прежде, просто без записи чеклиста.
    private readonly dossiers?: EmployerDossierService,
  ) {}

  /** Приёмка 38: не бросает — отправка не должна падать из-за аудита,
   * иначе правило «не блокирует» превратилось бы в «блокирует». */
  private async auditShipmentSafely(userId: string, projectId: string, action: string, resourceId: string) {
    if (!this.dossiers) return;
    try {
      await this.dossiers.auditShipment(userId, projectId, action, resourceId);
    } catch {
      // Проглатываем сознательно: см. комментарий выше.
    }
  }

  /** Мои профили кандидатов: созданные мной + расшаренные в команды, где я
   * состою. До этого TMA просил ввести ID профиля руками (create-only API). */
  async listMyCandidates(userId: string) {
    const memberships = await this.prisma.recruitingTeamMember.findMany({ where: { userId }, select: { teamId: true } });
    const teamIds = memberships.map((m: { teamId: string }) => m.teamId);
    return this.prisma.candidateProfile.findMany({
      where: { OR: [{ ownerUserId: userId }, ...(teamIds.length ? [{ recruitingTeamId: { in: teamIds } }] : [])] },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, displayName: true, contactInfo: true, recruitingTeamId: true, ownerUserId: true, consentRevokedAt: true, updatedAt: true },
    });
  }

  /** А-6 (аудит 2026-09-03): кандидат сказал «удалите мои данные» по почте
   * или в звонке — рекрутер отмечает это здесь. Раньше отзыв умел записывать
   * ТОЛЬКО сам соискатель через самошеринг: у кандидата, пришедшего мимо
   * продукта, отозвать согласие было физически нечем, и его разборы
   * продолжали уходить заказчику.
   *
   * Отзыв необратим этим маршрутом сознательно: «вернуть» согласие — значит
   * получить его заново, а не снять галочку в чужом интерфейсе. Вместе с
   * профилем гасятся все живые ссылки на него. */
  async revokeConsent(userId: string, candidateProfileId: string, dto: { candidateAskedToRevoke: boolean; note?: string | null }) {
    const profile = await this.assertOwnedProfile(userId, candidateProfileId);
    if (!dto.candidateAskedToRevoke) {
      throw new BadRequestException('Отзыв записывается только со слов самого кандидата — подтвердите, что он об этом попросил');
    }
    if (profile.consentRevokedAt) return { candidateProfileId, consentRevokedAt: profile.consentRevokedAt, alreadyRevoked: true, message: CONSENT_REVOKED_MESSAGE };
    const now = new Date();
    // Пункт [copy-outlived-consent] 2026-09-24: здесь гасились исходный
    // профиль и строки шеринга — но НЕ копии, уже принятые другой
    // стороной в свой проект. У них оставалось `consentRevokedAt: null`,
    // `assertConsentActive` там проходил, и по человеку, попросившему
    // его убрать, продолжали формироваться отчёты и доставки.
    //
    // Соседний маршрут отзыва (самошеринг соискателя) копию гасил с
    // самого начала. Теперь дорога одна и общая — и транзитивная:
    // принявший копию может поделиться ею дальше.
    const cascade = await revokeConsentCascade(this.prisma, candidateProfileId, now);
    await this.audit.record({
      actorId: userId,
      action: 'candidate_consent.revoked_by_recruiter',
      resource: 'CandidateProfile',
      resourceId: candidateProfileId,
      after: {
        note: dto.note?.slice(0, 500) ?? null,
        sharesRevoked: cascade.sharesRevoked,
        profilesRevoked: cascade.profilesRevoked,
        depthExhausted: cascade.depthExhausted,
      },
    });
    return {
      candidateProfileId,
      consentRevokedAt: now,
      sharesRevoked: cascade.sharesRevoked,
      // Копии названы отдельно от ссылок: для кандидата это разные вещи
      // — «ссылку закрыли» и «данные у принявшего больше не в работе».
      copiesRevoked: Math.max(0, cascade.profilesRevoked - 1),
      depthExhausted: cascade.depthExhausted,
      message: CONSENT_REVOKED_MESSAGE,
      // Пункт [the-outcome-reached-one-route-of-three] 2026-10-01.
      //
      // НАЙДЕННОЕ. Пункт [the-sentence-did-not-look-at-the-fact]
      // 2026-09-25 построил фразу ИЗ ИСХОДА («дошли не до конца — сказано
      // это, и сказано, что делать дальше») — и доехала она до ОДНОГО
      // маршрута отзыва из трёх. Здесь отдавалась ФИКСИРОВАННАЯ фраза
      // плюс сырые числа: при исчерпанной глубине продукт говорил
      // «копии помечены отозванными тоже», не глядя на то, что обход
      // остановился. Это та самая неправда, которую тот Пункт назвал
      // самой дорогой из возможных, — она просто осталась на двух
      // маршрутах.
      //
      // Текст строится теми же функциями, что на закрытом маршруте:
      // разъехаться формулировками значило бы завести ту же беду заново.
      alsoDone: revocationAlsoDone({
        sharesRevoked: cascade.sharesRevoked,
        copiesRevoked: Math.max(0, cascade.profilesRevoked - 1),
        depthExhausted: cascade.depthExhausted,
      }),
      doesNotUndo: revocationDoesNotUndo(
        {
          sharesRevoked: cascade.sharesRevoked,
          copiesRevoked: Math.max(0, cascade.profilesRevoked - 1),
          depthExhausted: cascade.depthExhausted,
        },
        CANDIDATE_REVOCATION_EFFECTS.doesNotUndo,
      ),
    };
  }

  /** Профиль доступен создателю или команде, в которой состоит пользователь. */
  private async assertOwnedProfile(userId: string, candidateProfileId: string) {
    const profile = await this.prisma.candidateProfile.findUnique({ where: { id: candidateProfileId } });
    if (!profile) throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
    if (profile.ownerUserId !== userId) {
      const inTeam = profile.recruitingTeamId
        ? await this.prisma.recruitingTeamMember.findUnique({ where: { teamId_userId: { teamId: profile.recruitingTeamId, userId } } })
        : null;
      if (!inTeam) throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
    }
    return profile;
  }

  async createCandidate(userId: string, displayName: string, contactInfo?: string, resumeText?: string, recruitingTeamId?: string) {
    if (!displayName.trim()) {
      throw new BadRequestException('displayName не может быть пустым');
    }
    if (recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: recruitingTeamId, userId } },
      });
      if (!membership) {
        throw new NotFoundException(`RecruitingTeam ${recruitingTeamId} not found`);
      }
    }
    return this.prisma.candidateProfile.create({
      data: {
        displayName: displayName.trim(),
        contactInfo,
        resumeText,
        // Належить команді АБО одноосібному власнику, не обидвом
        // одразу (§3.0 ТЗ, коментар у схемі).
        ownerUserId: recruitingTeamId ? undefined : userId,
        recruitingTeamId: recruitingTeamId ?? undefined,
      },
    });
  }

  // ── Домашнє завдання (§4.4 ТЗ) ──

  async listFollowUpRequests(userId: string, statusId: string) {
    await this.assertOwnedStatus(userId, statusId);
    return this.prisma.candidateFollowUpRequest.findMany({ where: { statusId }, orderBy: { createdAt: 'desc' } });
  }

  /** АУДИТ 2026-09-02 — ОБХОД ЗАМОРОЗКИ ПРОЕКТА. Маршрут объявляет
   *  `:statusId`, но обработчик его не использовал: статус брался из
   *  самой записи. ProjectFrozenGuard же резолвит проект ИМЕННО из
   *  параметра маршрута. Подставив в `:statusId` статус незамороженного
   *  проекта, а в `:id` — запрос из замороженного, можно было менять
   *  данные замороженного проекта. Теперь параметр маршрута обязан
   *  совпадать с владельцем записи. */
  async markFollowUpFulfilled(userId: string, statusId: string, requestId: string, fulfilled: boolean) {
    const request = await this.prisma.candidateFollowUpRequest.findUnique({
      where: { id: requestId },
      include: { status: true },
    });
    if (!request) {
      throw new NotFoundException(`CandidateFollowUpRequest ${requestId} not found`);
    }
    if (request.statusId !== statusId) {
      // Несовпадение неотличимо от несуществующей записи — не
      // раскрываем, что запрос существует в другом проекте.
      throw new NotFoundException(`CandidateFollowUpRequest ${requestId} not found`);
    }
    await this.assertOwnedStatus(userId, request.statusId);
    return this.prisma.candidateFollowUpRequest.update({ where: { id: requestId }, data: { fulfilled } });
  }

  /** Стадія воронки — РІШЕННЯ РЕКРУТЕРА (аудит 2026-09-03).
   *
   * Знайдено сверкой enum'а зі схемою: `stage` виставлявся тільки в двох
   * місцях — SCHEDULED при заведенні кандидата й AWAITING_FOLLOWUP
   * автоматично (§4.4, «єдиний автоматичний перехід, який система робить
   * сама»). INTERVIEWED і UNDER_REVIEW не виставляв ніхто: у воронці
   * зведеного звіту (§4.9) дві колонки з чотирьох були вічними нулями, а
   * рекрутер не мав чим рухати кандидата по процесу взагалі.
   *
   * Ставить стадію ЛЮДИНА, не модель: жодного AI-виклику тут немає й не
   * буде. ACCEPTED/REJECTED у enum'і немає навмисно (§2.3, п.2) —
   * фінальне рішення про найм фіксується поза цією моделлю, щоб продукт
   * не міг його «порадити». */
  async setStage(userId: string, statusId: string, stage: CandidateStage) {
    if (!Object.values(CandidateStage).includes(stage)) {
      throw new BadRequestException('Неизвестная стадия воронки');
    }
    const status = await this.assertOwnedStatus(userId, statusId);
    const updated = await this.prisma.candidatePipelineStatus.update({ where: { id: status.id }, data: { stage } });
    await this.audit.record({
      actorId: userId,
      action: 'candidate_pipeline_status.stage_changed',
      resource: 'CandidatePipelineStatus',
      resourceId: status.id,
      before: { stage: status.stage },
      after: { stage },
    });
    return updated;
  }

  // ── Обмін через Telegram (§4.6 ТЗ) ──

  /** Поштучний шеринг. §2.5 ТЗ, п.1 — без candidateConsentConfirmed=true
   * кнопка технічно недоступна, не тільки етично не рекомендована. */
  async shareCandidate(userId: string, candidateProfileId: string, candidateConsentConfirmed: boolean) {
    await this.assertOwnedOrTeamCandidate(userId, candidateProfileId);
    if (!candidateConsentConfirmed) {
      throw new BadRequestException('Без подтверждённого согласия кандидата на передачу поделиться нельзя');
    }
    const shareToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_MS);
    await this.prisma.candidateShare.create({
      data: {
        sourceCandidateId: candidateProfileId,
        sharedByUserId: userId,
        shareToken,
        expiresAt,
        candidateConsentConfirmed: true,
      },
    });
    // Проект берём из пула, куда кандидат заведён: у поштучного шеринга
    // projectId в аргументах нет, а чеклист отправки — про проект.
    const status = await this.prisma.candidatePipelineStatus.findFirst({
      where: { candidateProfileId },
      select: { projectId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (status) await this.auditShipmentSafely(userId, status.projectId, 'candidate_share.created', shareToken);

    return { deepLink: buildStartDeepLink(`share_${shareToken}`), expiresAt };
  }

  /** Пакетний шеринг усього пулу. §2.5 ТЗ: "не можна погодити всіх
   * одним чекбоксом" — candidateConsentConfirmed передається як
   * МАСИВ id, для яких згода підтверджена; решта пулу мовчки НЕ
   * потрапляє в пакет (не помилка на весь запит).
   *
   * АУДИТ ЗНАЙШОВ КРИТИЧНУ ДІРУ: цей метод раніше НЕ перевіряв
   * доступ userId до projectId взагалі — будь-який автентифікований
   * користувач міг поділитись усіма кандидатами ЧУЖОГО пулу, знаючи
   * лише projectId. Усі інші методи цього сервісу мають перевірку
   * власності/команди, цей — пропустили. Виправлено. */
  async shareAllInPool(userId: string, projectId: string, consentedCandidateIds: string[]) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    const allInPool = await this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      select: { candidateProfileId: true },
    });
    const consentedSet = new Set(consentedCandidateIds);
    const included = allInPool.filter((s: { candidateProfileId: string }) => consentedSet.has(s.candidateProfileId));
    const excludedCount = allInPool.length - included.length;

    if (included.length === 0) {
      throw new BadRequestException('Ни у одного кандидата пула нет подтверждённого согласия на передачу — пакет не может быть пустым');
    }

    const batchToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_MS);
    await this.prisma.candidateShare.createMany({
      data: included.map((s: { candidateProfileId: string }) => ({
        sourceCandidateId: s.candidateProfileId,
        sharedByUserId: userId,
        batchToken,
        expiresAt,
        candidateConsentConfirmed: true,
      })),
    });

    await this.auditShipmentSafely(userId, projectId, 'candidate_share.batch_created', batchToken);

    return { deepLink: buildStartDeepLink(`team_share_${batchToken}`), expiresAt, includedCount: included.length, excludedCount };
  }

  /** §4.6 ТЗ — попередній перегляд БЕЗ pipelineStatuses/relevanceEntries,
   * тільки displayName/resumeText. Приймає і shareToken (одиночний), і
   * batchToken (пакетний) — повертає масив з одним чи кількома
   * кандидатами відповідно. */
  async previewShare(token: string) {
    const shares = await this.prisma.candidateShare.findMany({
      where: { OR: [{ shareToken: token }, { batchToken: token }] },
      include: { sourceCandidate: { select: { displayName: true, resumeText: true } } },
    });
    if (shares.length === 0) {
      throw new NotFoundException('Ссылка недействительна');
    }
    // Пункт [term-never-ends] 2026-09-06. Две правки, и вторая важнее.
    //
    // Первая: общий предикат вместо переписанного по месту сравнения —
    // шестой вход по `CandidateShare`, и пятый уже успел про срок забыть.
    //
    // Вторая: проверялся ТОЛЬКО `shares[0]`. Сегодня это верно — пакет
    // создаётся одним `createMany` с общим `expiresAt`, — но верно ПО
    // СОВПАДЕНИЮ, а не по устройству: строки отдельные, поле у каждой
    // своё, и ничто не мешает им разойтись (продление одной ссылки из
    // пакета — очевидная будущая функция). Правило, которое держится на
    // том, что все значения сейчас равны, — это не правило. Проверяем
    // каждую.
    if (shares.some((sh: { expiresAt: Date }) => !termIsCurrent(sh))) {
      // Пункт [letters-were-not-the-language] 2026-09-24: фраза стояла
      // здесь по-украински, на ПУБЛИЧНОЙ странице по ссылке, и сверка
      // языка её не увидела — в ней нет ни одной из букв, по которым та
      // сверка язык определяла.
      throw new BadRequestException(TERM_OVER_MESSAGE);
    }
    // Аудит 2026-09-03 (сверка доступа): отзыв согласия ПИСАЛСЯ, но здесь
    // не читался — уже отправленная ссылка продолжала показывать профиль
    // кандидата все 72 часа TTL. Отзыв, который не гасит живую ссылку, —
    // это не отзыв. Причину называем прямо: получателю важно понимать,
    // что ссылка не «сломалась», а закрыта по просьбе самого кандидата.
    const active = shares.filter((s: { revokedAt: Date | null }) => !s.revokedAt);
    if (active.length === 0) {
      throw new ForbiddenException(CONSENT_REVOKED_MESSAGE);
    }
    // Аудит 2026-09-02 (job-landing): `accepted` — чтобы повторно
    // открытая ссылка не показывала кнопку «Принять» на уже принятом
    // профиле (нажатие давало 400 «вже було прийнято»). Кто принял —
    // не раскрываем: получателю нужен факт, не userId.
    return active.map((s: any) => ({
      shareId: s.id,
      displayName: s.sourceCandidate.displayName,
      resumeText: s.sourceCandidate.resumeText,
      accepted: s.acceptedAt != null,
    }));
  }

  /** §4.6 ТЗ — "явна дія отримувача, не автоматичний імпорт". Приймає
   * ОДИН конкретний shareId з preview (не весь пакет одразу) — новий
   * CandidateProfile, копія на момент прийняття, НЕ live-посилання на
   * оригінал. */
  async acceptShare(userId: string, shareId: string, token: string) {
    const share = await this.prisma.candidateShare.findUnique({
      where: { id: shareId },
      include: { sourceCandidate: true },
    });
    // Пункт [project-audit] 2026-09-01 (IDOR из отчёта аудита): раньше
    // хватало одного shareId — внутреннего cuid, который не является
    // секретом (мелькает в ответах API и логах). Теперь принятие
    // требует ещё и токен ссылки — то, что получатель реально получил
    // в deep-link'е. Несовпадение неотличимо от несуществующей ссылки
    // (не раскрываем, что shareId существует).
    // Пункт [the-guard-nobody-guarded] 2026-09-30: единственное во всём
    // дереве сравнение секрета обычным `!==`. Реестр публичных
    // поверхностей утверждает «через safeSecretEqual», и это было
    // правдой про восемь мест из девяти. Практическая эксплуатация
    // тайминга через сеть маловероятна — правится не ради неё, а ради
    // того, чтобы правило было ОДНО, а не восемь копий плюс
    // исключение.
    if (!share || !token?.trim() || (!safeSecretEqual(share.shareToken, token) && !safeSecretEqual(share.batchToken, token))) {
      throw new NotFoundException('Ссылка недействительна или просрочена');
    }
    // [term-never-ends] 2026-09-06: та же проверка, теперь общим
    // предикатом. Отзыв разбирается ниже отдельно и намеренно —
    // принимающая сторона здесь известна.
    if (!termIsCurrent(share)) {
      throw new NotFoundException(TERM_OVER_MESSAGE);
    }
    if (share.acceptedAt) {
      throw new BadRequestException('Эта ссылка уже была принята раньше');
    }
    // Тот же барьер, что в самошеринге соискателя (К-8): принять отозванный
    // шеринг нельзя, даже если ссылка ещё не истекла.
    if (share.revokedAt) {
      throw new ForbiddenException(CONSENT_REVOKED_MESSAGE);
    }

    // [job-domain-v2]: у самошеринга соискателя (К-8) источника-профиля
    // нет — он принимается своим маршрутом (CandidateSelfShareService).
    if (!share.sourceCandidate) {
      throw new BadRequestException('Это ссылка соискателя — принимается через /candidate-shares/accept');
    }
    // Пункт [two-profiles-one-consent] 2026-10-01.
    //
    // НАЙДЕННОЕ. Проверка `share.acceptedAt` стоит выше, а создание
    // профиля и отметка ссылки были ДВУМЯ отдельными вызовами без
    // транзакции и без условной записи. Два POST с одним токеном
    // (двойное нажатие, повтор клиента) оба видели `acceptedAt === null`,
    // оба создавали профиль, оба штамповали ссылку — а
    // `createdCandidateProfileId` сохранял ТОЛЬКО ПОБЕДИТЕЛЯ.
    //
    // ПОЧЕМУ ЭТО ХУЖЕ ЛИШНЕЙ СТРОКИ В БАЗЕ. Обход отзыва согласия
    // (`consent-revocation.ts`) идёт по цепочке ИМЕННО через
    // `createdCandidateProfileId`. Второй профиль из этой цепочки
    // выпадал — то есть живая копия персональных данных человека
    // переживала отзыв согласия, который продукт обещает довести до
    // всех копий. Самая дорогая порода неправды в этом продукте.
    //
    // Соседний путь — самошеринг соискателя — был завёрнут в
    // транзакцию Сверкой «половины операции» 2026-09-04; этот остался.
    // «Правило было, просто не везде» в чистом виде.
    //
    // ЧТО СДЕЛАНО. Забор ссылки УСЛОВНОЙ записью (`updateMany` с
    // `acceptedAt: null`) внутри транзакции: Postgres пропускает ровно
    // один запрос, второй видит ноль обновлённых строк и получает тот же
    // отказ, что и при последовательном повторе. Профиль создаётся в той
    // же транзакции, поэтому «ссылка сожжена, а профиля нет» тоже
    // невозможно.
    //
    // ЧЕГО НЕ СДЕЛАНО. Уникального индекса на
    // `CandidateShare.createdCandidateProfileId` не добавлено: он
    // защитил бы от этого же на уровне схемы, но потребовал бы миграции
    // и решения, что делать с уже существующими дублями, если они есть.
    // Названо здесь, чтобы следующий читатель не считал это закрытым.
    const newProfile = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.candidateShare.updateMany({
        where: { id: shareId, acceptedAt: null },
        data: { acceptedByUserId: userId, acceptedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Эта ссылка уже была принята раньше');
      }
      const created = await tx.candidateProfile.create({
        data: {
          ownerUserId: userId,
          displayName: share.sourceCandidate!.displayName,
          contactInfo: share.sourceCandidate!.contactInfo,
          resumeText: share.sourceCandidate!.resumeText,
        },
      });
      await tx.candidateShare.update({
        where: { id: shareId },
        data: { createdCandidateProfileId: created.id },
      });
      return created;
    });

    return newProfile;
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedOrTeamCandidate(userId: string, candidateProfileId: string) {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: candidateProfileId } });
    if (!candidate) {
      throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
    }
    if (candidate.ownerUserId === userId) return candidate;
    if (candidate.recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: candidate.recruitingTeamId, userId } },
      });
      if (membership) return candidate;
    }
    throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
  }

  private async assertOwnedStatus(userId: string, statusId: string) {
    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { id: statusId },
      include: { project: true },
    });
    if (!status) {
      throw new NotFoundException(`CandidatePipelineStatus ${statusId} not found`);
    }
    await assertInterviewPoolProjectAccess(this.prisma, userId, status.projectId);
    return status;
  }
}
