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
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, PublicSubmissionStatus } from '@prisma/client';

@Injectable()
export class PublicDiscussionService {
  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════ owner-side (TelegramAuthGuard) ═══════════════════════

  async enableSharing(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const token = randomBytes(24).toString('base64url'); // непредсказуемый, URL-safe
    return this.prisma.project.update({ where: { id: projectId }, data: { publicShareToken: token } });
  }

  async disableSharing(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.project.update({ where: { id: projectId }, data: { publicShareToken: null } });
  }

  async listSubmissionsForModeration(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.publicArgumentSubmission.findMany({
      where: { projectId },
      include: { participant: true },
      orderBy: { createdAt: 'desc' },
    });
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
      throw new BadRequestException(`Submission ${submissionId} already moderated (status=${submission.status})`);
    }

    if (decision === 'REJECT') {
      return this.prisma.publicArgumentSubmission.update({
        where: { id: submissionId },
        data: { status: PublicSubmissionStatus.REJECTED, moderatedAt: new Date() },
      });
    }

    const argument = await this.prisma.argument.create({
      data: { projectId, text: submission.text, stance: submission.stance },
    });
    return this.prisma.publicArgumentSubmission.update({
      where: { id: submissionId },
      data: { status: PublicSubmissionStatus.ACCEPTED, moderatedAt: new Date(), promotedToArgumentId: argument.id },
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
  async publicView(token: string) {
    const project = await this.findProjectByToken(token);

    const [acceptedArguments, submissions, comments, latestProtocol, latestClosingMessage] = await Promise.all([
      this.prisma.argument.findMany({
        where: { projectId: project.id, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.publicArgumentSubmission.findMany({
        where: { projectId: project.id },
        include: { participant: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.publicComment.findMany({
        where: { projectId: project.id },
        include: { participant: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.protocol.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.closingMessage.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
    ]);

    return {
      question: project.question,
      goal: project.goal,
      arguments: acceptedArguments,
      submissions,
      comments,
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

  async joinAsParticipant(token: string, displayName?: string) {
    const project = await this.findProjectByToken(token);
    return this.prisma.publicParticipant.create({
      data: { projectId: project.id, displayName: displayName?.trim() || null },
    });
  }

  async submitArgument(token: string, text: string, stance: 'PRO' | 'CON', participantId?: string) {
    const project = await this.findProjectByToken(token);
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    if (participantId) {
      await this.assertParticipantBelongsToProject(participantId, project.id);
    }
    return this.prisma.publicArgumentSubmission.create({
      data: { projectId: project.id, text: text.trim(), stance: stance as ArgumentStance, participantId: participantId ?? null },
    });
  }

  /** Простой счётчик — см. честное ограничение в шапке файла (нет
   * защиты от повторного голосования). */
  async vote(token: string, submissionId: string, direction: 'up' | 'down') {
    const project = await this.findProjectByToken(token);
    const submission = await this.prisma.publicArgumentSubmission.findFirst({ where: { id: submissionId, projectId: project.id } });
    if (!submission) {
      throw new NotFoundException(`PublicArgumentSubmission ${submissionId} not found`);
    }
    return this.prisma.publicArgumentSubmission.update({
      where: { id: submissionId },
      data: direction === 'up' ? { upvotes: submission.upvotes + 1 } : { downvotes: submission.downvotes + 1 },
    });
  }

  async addComment(token: string, text: string, participantId?: string) {
    const project = await this.findProjectByToken(token);
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    if (participantId) {
      await this.assertParticipantBelongsToProject(participantId, project.id);
    }
    return this.prisma.publicComment.create({
      data: { projectId: project.id, text: text.trim(), participantId: participantId ?? null },
    });
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
