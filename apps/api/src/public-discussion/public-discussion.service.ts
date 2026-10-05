// Пункт 56: PublicDiscussionService (§4.3/§4.5 ТЗ) — приватность
// фактов с публикацией только выводов + публичное обсуждение по
// ссылке, пункт 32 v3-роадмапа. По прямому запросу, четвёртый из семи
// ранее не начатых, крупнейший по объёму за весь заход.
//
// ЕДИНСТВЕННАЯ ФИЧА ЗА ВЕСЬ ЗАХОД С ПУБЛИЧНОЙ (НЕ TELEGRAM-
// АУТЕНТИФИЦИРОВАННОЙ) ПОВЕРХНОСТЬЮ API. Методы этого сервиса делятся
// на ДВЕ группы, вызываемые из РАЗНЫХ контроллеров с РАЗНОЙ
// аутентификацией (см. public-discussion.controller.ts):
// - owner-* методы — требуют assertProjectOwnership, вызываются из
//   PublicDiscussionController (за TelegramAuthGuard, как весь проект)
// - public-* методы — требуют только валидный publicShareToken,
//   вызываются из PublicDiscussionPublicController (БЕЗ
//   TelegramAuthGuard) — знание токена в URL и есть "аутентификация",
//   тот же принцип, что у большинства "share link"-фич.
//
// "УЧАСТНИКИ ВИДЯТ ТОЛЬКО ARGUMENT, ДОСТУПА К PersonFact НЕТ"
// (буквально §4.3 ТЗ) — publicView() возвращает question/goal проекта
// и ОБЩИЕ (targetPersonId=null, stance PRO/CON — не RECONCILIATION,
// не адресные под стейкхолдера) аргументы. НИКОГДА не запрашивает
// PersonFact/FactSource ни при каких обстоятельствах.
//
// ЧЕСТНЫЕ ОГРАНИЧЕНИЯ, ЗАДОКУМЕНТИРОВАННЫЕ ПРЯМО ЗДЕСЬ, НЕ СКРЫТЫЕ:
// (1) publicShareToken — не полноценная аутентификация участника,
// знание токена = доступ; (2) PublicParticipant — не identity-система,
// не предотвращает повторную регистрацию тем же человеком под другим
// именем; (3) голосование — простые счётчики БЕЗ защиты от повторного
// голосования (нет надёжной identity для этого при анонимном участии).
// Это применимые ограничения для "домовой чат/рабочая группа" уровня
// доверия (сама ТЗ говорит о такой аудитории), не для высокоставерных
// публичных голосований.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { assertUnderPublicWriteLimit, insertUnderPublicWriteLimit } from '../common/public-write-limits';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PAGE_LIMIT, pagedList, takeWithProbe } from '../common/page';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, PublicSubmissionStatus } from '@prisma/client';

@Injectable()
export class PublicDiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  // ═══════════════════════ owner-side (TelegramAuthGuard) ═══════════════════════

  /** Аудит моделей БД 2026-08-30, §2.3 — ConsentType.PUBLIC_SHARING существовал
   * в enum'е с чекпоинта, но ни один сервис его не требовал: включение
   * публичного доступа делало весь проект читаемым по токену без единой
   * проверки согласия — тот же класс бага, что уже закрывался для LOCATION
   * (Пункт 77). Тот же паттерн requireConsent(), что там. */
  async enableSharing(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    await this.consent.requireConsent(userId, ConsentType.PUBLIC_SHARING, projectId);
    const token = randomBytes(24).toString('base64url'); // непредсказуемый, URL-safe
    return this.prisma.project.update({ where: { id: projectId }, data: { publicShareToken: token } });
  }

  async disableSharing(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.project.update({ where: { id: projectId }, data: { publicShareToken: null } });
  }

  async listSubmissionsForModeration(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    // Сверка чтений без потолка 2026-09-04: заявки сюда пишет любой, у
    // кого есть публичная ссылка, а читались они все и сразу. Потолок с
    // честным флагом: обрезанный список, выглядящий полным, для модератора
    // хуже длинного — он решает, что рассмотрел всё.
    // Пункт [badge-was-the-key] 2026-09-24: `include: { participant: true }`
    // теперь принесло бы сюда и `withdrawToken` — удостоверение
    // участника, выданное ему одному. Автору проекта имя подавшего
    // нужно (он решает, принимать ли заявку), удостоверение — нет, и
    // получив его, он смог бы удалять чужое от чужого имени. Поля
    // перечислены поимённо: новое поле участника обязано попадать сюда
    // сознательно, а не само собой.
    const rows = await this.prisma.publicArgumentSubmission.findMany({
      where: { projectId },
      include: { participant: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: takeWithProbe(),
    });
    return pagedList(rows);
  }

  /** "Владелец решает, какие публичные аргументы принять в основной
   * расчёт, а какие отклонить" (§4.5 ТЗ, буквально). Принятие создаёт
   * РЕАЛЬНЫЙ Argument — до этого момента заявка нигде в основном
   * списке не участвует. */
  async moderate(userId: string, projectId: string, submissionId: string, decision: 'ACCEPT' | 'REJECT') {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const submission = await this.prisma.publicArgumentSubmission.findFirst({ where: { id: submissionId, projectId } });
    if (!submission) {
      throw new NotFoundException(`PublicArgumentSubmission ${submissionId} not found in project ${projectId}`);
    }
    if (submission.status !== PublicSubmissionStatus.PENDING) {
      throw new BadRequestException(`Эту заявку уже рассмотрели (${submission.status}) — повторная модерация ничего не изменит`);
    }

    if (decision === 'REJECT') {
      return this.prisma.publicArgumentSubmission.update({
        where: { id: submissionId },
        data: { status: PublicSubmissionStatus.REJECTED, moderatedAt: new Date() },
      });
    }

    // Сверка «половины операции» 2026-09-04: аргумент создавался, а
    // заявка помечалась принятой отдельным вызовом. Сбой между ними
    // оставлял заявку в PENDING при уже созданном аргументе — модератор
    // принимает её второй раз и получает в своём проекте дубль, не
    // понимая, откуда он взялся.
    return this.prisma.$transaction(async (tx) => {
      const argument = await tx.argument.create({
        data: { projectId, text: submission.text, stance: submission.stance },
      });
      return tx.publicArgumentSubmission.update({
        where: { id: submissionId },
        data: { status: PublicSubmissionStatus.ACCEPTED, moderatedAt: new Date(), promotedToArgumentId: argument.id },
      });
    });
  }

  // ═══════════════════════ public-side (token-based) ═══════════════════════

  /** "Участники видят только Argument, доступа к PersonFact нет"
   * (§4.3 ТЗ) — НИКОГДА не запрашивает PersonFact/FactSource. Только
   * общие (не адресные, не RECONCILIATION) аргументы проекта.
   *
   * Пункт 80 (пункт 38 общего списка, "командный режим", узкий
   * read-only объём, согласованный явно перед реализацией — НЕ
   * полноценный многопользовательский доступ) — добавлены протокол
   * (Пункт 62) и завершающее сообщение (Пункт 72), если сгенерированы.
   * Оба уже прошли ту же дисциплину "только Argument покидает
   * приложение", что и остальной этот метод — не новая категория
   * риска, то же самое расширение той же уже существующей ссылки.
   * Осознанно НЕ добавлены: CompromiseSheet (менее устоявшееся
   * содержание, привязано к сессии спарринга), ProjectLog (раскрывает
   * динамику конфликта между конкретными людьми), SchedulerAdvice
   * (личные предпочтения человека, показанные третьей стороне без
   * его ведома) — см. обсуждение перед реализацией в /TODO.md. */
  /** Пункт [badge-was-the-key] 2026-09-24 — `viewerParticipantId` нужен
   * только чтобы отметить «это моё» и НЕ является удостоверением:
   * удостоверение (`withdrawToken`) выдаётся один раз при входе и в
   * ответы не попадает никогда. Сам `participantId` из ответов убран —
   * см. разбор над `withdrawComment`. */
  async publicView(token: string, viewerParticipantId?: string) {
    const project = await this.findProjectByToken(token);

    const [acceptedArguments, submissions, comments, latestProtocol, latestClosingMessage] = await Promise.all([
      // Сверка чтений без потолка 2026-09-04: это НЕАУТЕНТИФИЦИРОВАННЫЙ
      // маршрут, и два из трёх списков растит посторонний — заявки и
      // комментарии пишет любой, у кого есть ссылка. Читались они целиком
      // при каждом открытии страницы каждым участником.
      // Пункт [badge-was-the-key] 2026-09-24: строка отдавалась ЦЕЛИКОМ,
      // вместе с `weight` — субъективной оценкой силы аргумента,
      // которую ставит автор проекта для себя. Страница её не
      // показывает, то есть человек не мог даже узнать, что его
      // взвешивание уходит всем, у кого есть ссылка. Та же «невидимая
      // на странице выдача», что закрыл пункт [public-name] на именах.
      this.prisma.argument.findMany({
        where: { projectId: project.id, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
        select: { id: true, text: true, stance: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: takeWithProbe(),
      }),
      // Пункт [public-name] 2026-09-05: имя участника уходило вместе с
      // заявками КАЖДОМУ, кто открыл ссылку, — хотя экран его там не
      // показывает. Невидимая на странице выдача: человек не мог даже
      // узнать, что его имя путешествует. Заявки показываются без имени,
      // значит и отдавать его незачем.
      this.prisma.publicArgumentSubmission.findMany({
        where: { projectId: project.id },
        select: { id: true, text: true, stance: true, status: true, upvotes: true, downvotes: true, participantId: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: takeWithProbe(),
      }),
      this.prisma.publicComment.findMany({
        where: { projectId: project.id },
        select: { id: true, text: true, createdAt: true, participantId: true, participant: { select: { displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: takeWithProbe(),
      }),
      // Поля названы поимённо и ЗДЕСЬ, а не только на выходе: читать
      // строку целиком, чтобы вернуть два поля, — способ однажды
      // вернуть её целиком.
      this.prisma.protocol.findFirst({
        where: { projectId: project.id },
        select: { summaryText: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.closingMessage.findFirst({
        where: { projectId: project.id },
        select: { summaryText: true, quoteText: true, quoteSourceReference: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    // Пункт [badge-was-the-key] 2026-09-24: `participantId` не уходит
    // наружу ни в одном списке. Он был не только удостоверением — он
    // ещё и СШИВАЛ два списка: заявки показываются без имени (это
    // решение пункта [public-name]), комментарии — с именем, и общий
    // `participantId` возвращал имя к «безымянной» заявке. Прямой путь
    // тогда закрыли, обходной остался.
    const mine = (participantId: string | null) =>
      Boolean(viewerParticipantId) && participantId === viewerParticipantId;

    const submissionsPage = pagedList(submissions);
    const commentsPage = pagedList(comments);

    return {
      question: project.question,
      goal: project.goal,
      arguments: pagedList(acceptedArguments).items,
      argumentsHasMore: pagedList(acceptedArguments).hasMore,
      submissions: submissionsPage.items.map(({ participantId, ...rest }) => ({ ...rest, mine: mine(participantId) })),
      submissionsHasMore: submissionsPage.hasMore,
      comments: commentsPage.items.map(({ participantId, participant, ...rest }) => ({
        ...rest,
        authorName: participant?.displayName ?? null,
        mine: mine(participantId),
      })),
      commentsHasMore: commentsPage.hasMore,
      pageLimit: DEFAULT_PAGE_LIMIT,
      protocol: latestProtocol ? { summaryText: latestProtocol.summaryText, createdAt: latestProtocol.createdAt } : null,
      closingMessage: latestClosingMessage
        ? {
            summaryText: latestClosingMessage.summaryText,
            quoteText: latestClosingMessage.quoteText,
            quoteSourceReference: latestClosingMessage.quoteSourceReference,
            createdAt: latestClosingMessage.createdAt,
          }
        : null,
    };
  }

  /** Пункт [badge-was-the-key] 2026-09-24: `withdrawToken` отдаётся
   * ОДИН раз — тому, кто вошёл. Больше он не появляется нигде. */
  async joinAsParticipant(token: string, displayName?: string) {
    const project = await this.findProjectByToken(token);
    // Пункт [the-open-door-had-no-counter] 2026-09-30: до этой строки
    // знание ссылки позволяло завести сколько угодно участников.
    // Пункт [the-public-door-counted-then-crossed] 2026-10-05: счёт и
    // запись — ОДНО событие под замком. Проверка отдельным обращением не
    // держала ничего: одновременные запросы читали один счёт.
    return insertUnderPublicWriteLimit(
      this.prisma,
      'participants-per-discussion',
      project.id,
      (tx) => tx.publicParticipant.count({ where: { projectId: project.id } }),
      (tx) =>
        tx.publicParticipant.create({
          data: { projectId: project.id, displayName: displayName?.trim() || null },
          // Единственное место во всём проекте, где `withdrawToken`
          // называется в `select`, — и получает его тот, кому он выдан.
          select: { id: true, displayName: true, createdAt: true, withdrawToken: true },
        }),
    );
  }

  async submitArgument(token: string, text: string, stance: 'PRO' | 'CON', participantId?: string) {
    const project = await this.findProjectByToken(token);
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    if (participantId) {
      await this.assertParticipantBelongsToProject(participantId, project.id);
    }
    // Пункт [the-open-door-had-no-counter] 2026-09-30: очередь модерации
    // разбирает человек, и неограниченная очередь означает, что её не
    // разберут никогда.
    // Пункт [the-public-door-counted-then-crossed] 2026-10-05: ОБА
    // потолка и запись — одним событием под замком обсуждения. Прежде
    // это были три отдельных обращения, и одновременные запросы
    // проходили все. Замок берётся по обсуждению, а не по участнику:
    // личный потолок считается внутри него, и брать два замка значило
    // бы завести порядок их взятия, то есть способ получить взаимную
    // блокировку.
    // Пункт [the-ceiling-asked-you-to-identify-yourself] 2026-09-30 —
    // ЛИЧНЫЙ ПОТОЛОК ПРИМЕНЯЕТСЯ И К АНОНИМНОЙ ЗАПИСИ.
    //
    // Раньше проверка стояла под `if (participantId)`. Поле
    // необязательное, и клиент, его НЕ приславший, не попадал под
    // личный потолок вообще — его держал только общий на обсуждение.
    // То есть обещание «не больше N от одного» обходилось тем, что
    // человек не называл себя, и обходилось бесплатно: назваться стоит
    // строки в таблице участников (их потолок 200), а не назваться —
    // ничего. Личный потолок существовал ровно для того, чтобы очередь
    // модерации разобрал человек, и для анонимной записи не работал.
    //
    // Анонимные записи считаются ОДНОЙ общей корзиной того же размера:
    // назвавшийся получает свой счёт, не назвавшиеся делят один. Это
    // осознанный размен, и он назван: в людном обсуждении анонимная
    // запись кончится быстрее, и правильный ответ на это —
    // присоединиться (это бесплатно), а не поднять потолок.
    //
    // Честная граница, уже записанная в шапке файла: `PublicParticipant`
    // не identity-система, и повторная регистрация под другим именем
    // по-прежнему возможна. Она стоит строки участника и упирается в
    // потолок участников; это дороже, чем пустое поле, и потому другой
    // разговор.
    // Пункт [badge-was-the-key] 2026-09-24: подача заявки возвращала
    // строку целиком, вместе с `participantId`. Своё удостоверение
    // подавший и так знает — но правило поверхности не делает
    // исключений «здесь не страшно»: именно такие исключения и
    // заканчиваются полем, о котором никто не подумал.
    return insertUnderPublicWriteLimit(
      this.prisma,
      'submissions-per-discussion',
      project.id,
      (tx) => tx.publicArgumentSubmission.count({ where: { projectId: project.id } }),
      async (tx) => {
        await assertUnderPublicWriteLimit('submissions-per-participant', () =>
          tx.publicArgumentSubmission.count({
            where: { projectId: project.id, participantId: participantId ?? null },
          }),
        );
        return tx.publicArgumentSubmission.create({
          data: { projectId: project.id, text: text.trim(), stance: stance as ArgumentStance, participantId: participantId ?? null },
          select: { id: true, text: true, stance: true, status: true, upvotes: true, downvotes: true, createdAt: true },
        });
      },
    );
  }

  /** Простой счётчик — см. честное ограничение в шапке файла (нет
   * защиты от повторного голосования). */
  async vote(token: string, submissionId: string, direction: 'up' | 'down') {
    const project = await this.findProjectByToken(token);
    const submission = await this.prisma.publicArgumentSubmission.findFirst({
      where: { id: submissionId, projectId: project.id },
      select: { id: true },
    });
    if (!submission) {
      throw new NotFoundException(`PublicArgumentSubmission ${submissionId} not found`);
    }
    // Пункт [outside-input] 2026-09-04. Здесь стояло ровно то, что
    // повторный аудит 2026-08-30 нашёл и исправил в СОСЕДНЕЙ публичной
    // фиче (library.service.ts, метод с тем же именем) — и здесь не
    // исправил: чтение-потом-запись (`submission.upvotes + 1`) на
    // публичном неаутентифицированном эндпоинте. Два одновременных
    // голоса перезаписывают друг друга (классический lost update), и на
    // однопоточном моке это не воспроизводится в принципе.
    // `{ increment: 1 }` выполняет инкремент на стороне Postgres, где он
    // атомарен. Вторая половина того же исправления — явная проверка
    // `direction`: без неё любое значение, кроме строки 'up', молча
    // считалось голосом «против».
    if (direction !== 'up' && direction !== 'down') {
      throw new BadRequestException(`direction должен быть 'up' или 'down', получено: ${String(direction)}`);
    }
    // Пункт [badge-was-the-key] 2026-09-24: голос возвращал строку
    // целиком — вместе с `participantId`, то есть с удостоверением
    // автора заявки. Публичное чтение сузили, а публичную ЗАПИСЬ,
    // возвращающую ту же строку, — нет.
    return this.prisma.publicArgumentSubmission.update({
      where: { id: submissionId },
      data: direction === 'up' ? { upvotes: { increment: 1 } } : { downvotes: { increment: 1 } },
      select: { id: true, text: true, stance: true, status: true, upvotes: true, downvotes: true, createdAt: true },
    });
  }

  /** Пункт [public-name] 2026-09-05 — забрать своё.
   *
   * НАЙДЕНО: у участника публичного обсуждения не было НИ ОДНОГО
   * способа убрать написанное. Он приходит по ссылке, у него нет
   * аккаунта, автор проекта ему никто — и всё, что он написал, остаётся
   * навсегда, подписанное именем, которое он ввёл, не зная, где оно
   * появится.
   *
   * Опознаём по его же `participantId` — другого удостоверения у него
   * нет и заводить его ради этого было бы хуже: аккаунт там, где человек
   * пришёл по ссылке на пять минут, — не право, а условие.
   *
   * ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24. Строки выше
   * остаются датированной записью замысла; вот что из него вышло.
   * `participantId` действительно стал удостоверением — и он же
   * печатался в ответе публичной страницы для КАЖДОГО участника.
   * Открывший ссылку получал список чужих удостоверений и мог удалить
   * любой комментарий и забрать любую непринятую заявку. Проверка
   * `where: { participantId }` и текст ошибки «написан не вами»
   * выглядели правом собственности, а проверяли ровно одно: знает ли
   * спрашивающий число, только что ему показанное.
   *
   * Соседний комментарий в контроллере довершает картину: там сказано,
   * что идентификатор передаётся ТЕЛОМ, а не путём, «чтобы не оседал в
   * логах прокси». Удостоверение берегли от логов и печатали на самой
   * странице.
   *
   * Теперь опознаёт `withdrawToken`: выдаётся один раз при входе, в
   * списки не попадает. Вывод общий и записан отдельно: ОПОЗНАВАТЬ
   * МОЖНО ТОЛЬКО ПО ТОМУ, ЧЕГО НЕ ОТДАВАЛ ДРУГИМ.
   *
   * ЧЕГО ЭТО НЕ ДЕЛАЕТ: принятую автором заявку удалить отсюда нельзя.
   * Она уже стала аргументом проекта — отдельной записью, которая живёт
   * своей жизнью. Сказать «удалено» и оставить её там было бы обещанием
   * без исполнения, как в пункте [candidate-rights]. */
  async withdrawComment(token: string, commentId: string, withdrawToken: string) {
    const project = await this.findProjectByToken(token);
    const participantId = await this.participantByWithdrawToken(project.id, withdrawToken);
    const comment = await this.prisma.publicComment.findFirst({
      where: { id: commentId, projectId: project.id, participantId },
      select: { id: true },
    });
    if (!comment) {
      throw new NotFoundException('Комментарий не найден или написан не вами');
    }
    await this.prisma.publicComment.delete({ where: { id: commentId } });
    return { deleted: true as const };
  }

  async withdrawSubmission(token: string, submissionId: string, withdrawToken: string) {
    const project = await this.findProjectByToken(token);
    const participantId = await this.participantByWithdrawToken(project.id, withdrawToken);
    const submission = await this.prisma.publicArgumentSubmission.findFirst({
      where: { id: submissionId, projectId: project.id, participantId },
      select: { id: true, status: true },
    });
    if (!submission) {
      throw new NotFoundException('Заявка не найдена или отправлена не вами');
    }
    if (submission.status === PublicSubmissionStatus.ACCEPTED) {
      throw new BadRequestException(
        'Эту заявку автор уже принял — она стала аргументом проекта и живёт отдельно от неё. Отозвать её здесь нельзя; напишите автору, если хотите, чтобы он убрал аргумент.',
      );
    }
    await this.prisma.publicArgumentSubmission.delete({ where: { id: submissionId } });
    return { deleted: true as const };
  }

  async addComment(token: string, text: string, participantId?: string) {
    const project = await this.findProjectByToken(token);
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    if (participantId) {
      await this.assertParticipantBelongsToProject(participantId, project.id);
    }
    // Пункт [the-public-door-counted-then-crossed] 2026-10-05: оба
    // потолка и запись — одним событием под замком обсуждения, как у
    // заявок выше. Три отдельных обращения не держали ничего.
    return insertUnderPublicWriteLimit(
      this.prisma,
      'comments-per-discussion',
      project.id,
      (tx) => tx.publicComment.count({ where: { projectId: project.id } }),
      async (tx) => {
        // Пункт [the-ceiling-asked-you-to-identify-yourself] 2026-09-30 —
        // то же, что у заявок выше: личный потолок обходился пустым полем.
        await assertUnderPublicWriteLimit('comments-per-participant', () =>
          tx.publicComment.count({
            where: { projectId: project.id, participantId: participantId ?? null },
          }),
        );
        // Пункт [badge-was-the-key] 2026-09-24: наружу возвращается только
        // id созданного — страница всё равно перечитывает список, а лишние
        // поля в ответе это лишние поля наружу.
        return tx.publicComment.create({
          data: { projectId: project.id, text: text.trim(), participantId: participantId ?? null },
          select: { id: true },
        });
      },
    );
  }

  /** Секрет → чей он, в пределах ЭТОГО проекта. Пустая строка не
   * годится: иначе участник без секрета совпал бы с записями, у которых
   * автора нет, и «забрать своё» стало бы «забрать ничьё». */
  private async participantByWithdrawToken(projectId: string, withdrawToken: string): Promise<string> {
    const participant = withdrawToken?.trim()
      ? await this.prisma.publicParticipant.findFirst({
          where: { withdrawToken: withdrawToken.trim(), projectId },
          select: { id: true },
        })
      : null;
    if (!participant) {
      throw new NotFoundException('Написанное не найдено или написано не вами');
    }
    return participant.id;
  }

  private async findProjectByToken(token: string) {
    const project = await this.prisma.project.findFirst({ where: { publicShareToken: token } });
    if (!project) {
      throw new NotFoundException('Ссылка на обсуждение недействительна или обсуждение больше не публично доступно');
    }
    return project;
  }

  private async assertParticipantBelongsToProject(participantId: string, projectId: string) {
    const participant = await this.prisma.publicParticipant.findFirst({ where: { id: participantId, projectId } });
    if (!participant) {
      throw new ForbiddenException('participantId не относится к этому обсуждению');
    }
  }
}
