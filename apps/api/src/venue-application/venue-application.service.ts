// Пункт 66: VenueApplicationService (§3.23 ТЗ) — "Приём заявок от
// владельцев заведений", пункт 41 общего списка v4-роадмапа. По
// прямому запросу — разблокирует монетизацию §3.22, честно отложенную
// в Пункте 65 (см. /TODO.md).
//
// НЕТ AI-ВЫЗОВОВ ВООБЩЕ — это CRUD-флоу поверх Google Places
// (автоподбор данных) + ручная модерация, ТЗ не описывает никакого
// AI-сгенерированного контента для этой конкретной фичи.
//
// ВНУТРЕННИЙ СКОРИНГ ЧЕСТНО ОГРАНИЧЕН РЕЙТИНГОМ GOOGLE — см. подробное
// обоснование над моделями VenueApplication/ApprovedVenue в
// schema.prisma и в /TODO.md: полная формула по ТЗ требует трекинга
// бронирований и системы жалоб, которых не существует.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength , IsNotEmpty} from 'class-validator';
import { MoneyLike, sumMoney } from '../common/money';
import { SecretsService } from '../secrets/secrets.service';
import { getPlaceDetails, searchByText } from '../venue-recommendation/google-places-client';
import { VenueApplicationStatus } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';

const GOOGLE_PLACES_API_KEY_REF = 'GOOGLE_PLACES_API_KEY';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class SubmitApplicationInput {
  @IsString() @MinLength(1) @MaxLength(300) name!: string;
  @IsString() @MinLength(1) @MaxLength(500) address!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50) phone?: string;
  // Семь строк расписания — по одной на день недели, с запасом.
  @IsOptional() @IsArray() @ArrayMaxSize(14) @IsString({ each: true }) @IsNotEmpty({ each: true }) @MaxLength(200, { each: true }) openingHours?: string[];
  @IsOptional() @IsString() @MaxLength(300) googlePlaceId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @IsNotEmpty({ each: true }) @MaxLength(2000, { each: true }) photoReferences?: string[];
}

@Injectable()
export class VenueApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** "Гео и автоопределение заведения... по геолокации/названию"
   * (буквально §3.23 ТЗ) — поиск-кандидатов для владельца, не
   * персистит ничего сама, только предлагает варианты для выбора. */
  async searchCandidates(query: string, latitude?: number, longitude?: number) {
    if (!query.trim()) {
      throw new BadRequestException('query не может быть пустым');
    }
    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);
    try {
      return await searchByText(query.trim(), apiKey, latitude, longitude);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }
  }

  /** "Автоподгрузка контактов, адреса, часов работы, фото" (§3.23 ТЗ)
   * — по выбранному placeId, для предзаполнения формы заявки перед
   * "редактированием автоподгруженных данных". */
  async getAutofillData(googlePlaceId: string) {
    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);
    try {
      const details = await getPlaceDetails(googlePlaceId, apiKey);
      return {
        name: details.name,
        address: details.address,
        phone: details.phone,
        openingHours: details.openingHours,
        photoReferences: details.photoReferences,
      };
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }
  }

  /** "Владелец подаёт заявку" — принимает УЖЕ отредактированные
   * владельцем данные (после автоподгрузки + правок), не запрашивает
   * Google Places повторно сама — снапшот на момент подачи. */
  async submitApplication(userId: string, input: SubmitApplicationInput) {
    if (!input.name.trim() || !input.address.trim()) {
      throw new BadRequestException('name и address обязательны');
    }
    return this.prisma.venueApplication.create({
      data: {
        submittedByUserId: userId,
        name: input.name.trim(),
        address: input.address.trim(),
        phone: input.phone?.trim() || null,
        openingHours: input.openingHours ?? [],
        googlePlaceId: input.googlePlaceId ?? null,
        photoReferences: input.photoReferences ?? [],
      },
    });
  }

  async listMyApplications(userId: string) {
    return this.prisma.venueApplication.findMany({
      where: { submittedByUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPendingForModeration(userId: string) {
    await this.assertModerator(userId);
    return this.prisma.venueApplication.findMany({
      where: { status: VenueApplicationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** "Ручная модерация" (§3.23 ТЗ) — заявки не публикуются
   * автоматически. Принятие создаёт ApprovedVenue со снапшотом данных
   * + рейтингом Google на момент одобрения (не живая ссылка).
   * referralFeeAmount — опциональная согласованная с заведением
   * реферальная плата (Пункт 67, §3.22 "Монетизация") — можно указать
   * сразу при одобрении или задать позже через setReferralFee(). */
  async moderate(userId: string, applicationId: string, decision: 'APPROVE' | 'REJECT', referralFeeAmount?: number) {
    await this.assertModerator(userId);
    const application = await this.prisma.venueApplication.findUnique({ where: { id: applicationId } });
    if (!application) {
      throw new NotFoundException(`VenueApplication ${applicationId} not found`);
    }
    if (application.status !== VenueApplicationStatus.PENDING) {
      throw new BadRequestException(`Эту заявку уже рассмотрели (${application.status}) — повторная модерация ничего не изменит`);
    }

    if (decision === 'REJECT') {
      const updated = await this.prisma.venueApplication.update({
        where: { id: applicationId },
        data: { status: VenueApplicationStatus.REJECTED, moderatedAt: new Date() },
      });
      await this.auditLog.record({
        actorId: userId,
        action: 'venue_application.rejected',
        resource: 'VenueApplication',
        resourceId: applicationId,
        before: { status: application.status },
        after: { status: updated.status },
      });
      return updated;
    }

    let rating: number | null = null;
    if (application.googlePlaceId) {
      try {
        const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);
        const details = await getPlaceDetails(application.googlePlaceId, apiKey);
        rating = details.rating;
      } catch {
        rating = null; // рейтинг недоступен на момент одобрения — не блокируем одобрение из-за этого
      }
    }

    await this.prisma.approvedVenue.create({
      data: {
        applicationId,
        name: application.name,
        address: application.address,
        phone: application.phone,
        openingHours: application.openingHours,
        photoReferences: application.photoReferences,
        rating,
        referralFeeAmount: referralFeeAmount ?? null,
      },
    });
    const approved = await this.prisma.venueApplication.update({
      where: { id: applicationId },
      data: { status: VenueApplicationStatus.APPROVED, moderatedAt: new Date() },
    });

    // Пункт [audit-log] — referralFeeAmount у after, бо це фінансово
    // значуще рішення оператора, не тільки зміна статусу.
    await this.auditLog.record({
      actorId: userId,
      action: 'venue_application.approved',
      resource: 'VenueApplication',
      resourceId: applicationId,
      before: { status: application.status },
      after: { status: approved.status, referralFeeAmount: referralFeeAmount ?? null },
    });

    return approved;
  }

  // ── public (без аутентификации — "публичная карточка", буквально ТЗ) ──

  /** Пункт [public-row-whole] 2026-09-06 — что именно видит витрина.
   *
   * ЧТО БЫЛО. Оба метода отдавали СТРОКУ ЦЕЛИКОМ, а зовёт их
   * контроллер `public/venues` — БЕЗ АУТЕНТИФИКАЦИИ ВООБЩЕ, намеренно
   * («публичная карточка», §3.23 ТЗ). Вместе с названием и адресом
   * наружу уходило:
   *
   *  • `referralFeeAmount` — сумма реферальной платы, СОГЛАСОВАННАЯ С
   *    КОНКРЕТНЫМ ЗАВЕДЕНИЕМ. Коммерческое условие между продуктом и
   *    заведением, доступное любому в интернете: соседнее заведение
   *    видит, сколько платит это, а это — что платит больше соседнего;
   *  • `applicationId` — ссылка на заявку, сама заявка публичной не
   *    является.
   *
   * Витрине не нужно ни то, ни другое. Комиссия остаётся там, где ей
   * место: `approved-venues/:id/commission-summary` под операторским
   * guard'ом.
   *
   * Поля перечислены поимённо, а не «всё, кроме»: новое поле у
   * заведения должно попадать в публичную витрину СОЗНАТЕЛЬНО. Именно
   * «всё, кроме» здесь и не было — была строка целиком. */
  private static readonly PUBLIC_VENUE_FIELDS = {
    id: true,
    name: true,
    address: true,
    phone: true,
    openingHours: true,
    photoReferences: true,
    rating: true,
    isPriorityPartner: true,
    createdAt: true,
  } as const;

  async listApprovedVenues() {
    return this.prisma.approvedVenue.findMany({
      orderBy: { createdAt: 'desc' },
      select: VenueApplicationService.PUBLIC_VENUE_FIELDS,
    });
  }

  async getApprovedVenue(id: string) {
    const venue = await this.prisma.approvedVenue.findUnique({
      where: { id },
      select: VenueApplicationService.PUBLIC_VENUE_FIELDS,
    });
    if (!venue) {
      throw new NotFoundException(`ApprovedVenue ${id} not found`);
    }
    return venue;
  }

  // ═══════════════════════ Пункт 67 (§3.22 "Монетизация") ═══════════════════════

  /** Согласовать/изменить реферальную плату отдельно от момента
   * одобрения — переговоры с заведением могут занять время. */
  async setReferralFee(userId: string, approvedVenueId: string, referralFeeAmount: number | null) {
    await this.assertModerator(userId);
    const before = await this.assertVenueExists(approvedVenueId);
    const updated = await this.prisma.approvedVenue.update({
      where: { id: approvedVenueId },
      data: { referralFeeAmount },
    });
    // Пункт [operator-money-untraced] 2026-09-24: этого следа не было.
    // Одобрение и отклонение заявки заведения аудировались с самого
    // начала, а согласование ПЛАТЫ — нет, при том что это решение
    // оператора о деньгах с внешней стороной. Отсутствие следа здесь
    // хуже, чем где-либо ещё на операторской поверхности: у остальных
    // действий спорить можно о последствиях, у этого — о сумме.
    await this.auditLog.record({
      actorId: userId,
      action: 'approved_venue.referral_fee_set',
      resource: 'ApprovedVenue',
      resourceId: approvedVenueId,
      before: { referralFeeAmount: before.referralFeeAmount ?? null },
      after: { referralFeeAmount },
    });
    return updated;
  }

  /** "Приоритетное размещение... промаркировано как реклама" (§3.22
   * ТЗ) — модератор включает/выключает, TMA обязана визуально отделять
   * такие карточки в публичной выдаче. */
  async setPriorityPartner(userId: string, approvedVenueId: string, isPriorityPartner: boolean) {
    await this.assertModerator(userId);
    const before = await this.assertVenueExists(approvedVenueId);
    const updated = await this.prisma.approvedVenue.update({
      where: { id: approvedVenueId },
      data: { isPriorityPartner },
    });
    // Пункт [operator-money-untraced] 2026-09-24. Этот флаг поднимает
    // заведение НАД органической выдачей — экран рисует такие карточки
    // отдельным списком с пометкой «Реклама». То есть оператор одним
    // переключателем меняет то, что человек увидит первым, и до этой
    // правки не оставлял следа. Пометка «реклама» честна перед
    // читателем, но она не отвечает на вопрос «кто и когда решил» —
    // а платное продвижение ровно этот вопрос и порождает.
    await this.auditLog.record({
      actorId: userId,
      action: 'approved_venue.priority_partner_set',
      resource: 'ApprovedVenue',
      resourceId: approvedVenueId,
      before: { isPriorityPartner: before.isPriorityPartner },
      after: { isPriorityPartner },
    });
    return updated;
  }

  /** "Комиссия... за бронь, сделанную через сервис" (§3.22 ТЗ) —
   * ЧЕСТНО ограничено самоотчётом пользователя ("я забронировал"), не
   * верифицируемым фактом (нет автоматического бронирования, нет
   * платёжной интеграции — см. подробное обоснование над моделью
   * VenueBookingConfirmation в schema.prisma). Это ЛЕДЖЕР, не система
   * сбора платежей. */
  async confirmBooking(userId: string, approvedVenueId: string, scheduledConversationId?: string) {
    const venue = await this.assertVenueExists(approvedVenueId);
    // Аудит 2026-09-03 (сверка доступа): ссылка на встречу приходила из
    // тела запроса и не проверялась — в собственное подтверждение можно
    // было записать чужой scheduledConversationId. Прочитать по нему
    // ничего нельзя (поле нигде не читается), но чужой идентификатор в
    // своей строке — это заготовка утечки для того, кто однажды начнёт
    // это поле читать.
    if (scheduledConversationId) {
      const own = await this.prisma.scheduledConversation.findFirst({
        where: { id: scheduledConversationId, project: { ownerId: userId } },
        select: { id: true },
      });
      if (!own) throw new NotFoundException(`ScheduledConversation ${scheduledConversationId} not found`);
    }
    // Пункт [self-reported-money] 2026-09-05 — одна отметка на человека
    // в день на заведение.
    //
    // НАЙДЕНО: `confirmBooking` создавал строку на КАЖДЫЙ вызов. Человек
    // мог нажать «я забронировал» десять раз подряд — и сумма, которую
    // оператор видит как «к оплате» для заведения, вырастала в десять
    // раз. Заведение при этом не подтверждало ничего и о цифре не знало.
    //
    // Это НЕ проверка брони: продукт не умеет её проверить и делать вид,
    // что умеет, не будет. Это только защита от очевидного умножения —
    // тот же приём, что в пункте [click-count], где доля о человеке
    // росла от нажатий.
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const already = await this.prisma.venueBookingConfirmation.findFirst({
      where: { approvedVenueId, confirmedByUserId: userId, createdAt: { gte: dayStart } },
    });
    if (already) {
      throw new BadRequestException(
        'Вы уже отмечали бронь в этом заведении сегодня. Повторная отметка ничего не добавит — это ваша пометка о состоявшейся брони, а не счёт заведению.',
      );
    }

    return this.prisma.venueBookingConfirmation.create({
      data: {
        approvedVenueId,
        confirmedByUserId: userId,
        scheduledConversationId: scheduledConversationId ?? null,
        // Снапшот на момент подтверждения — не пересчитывается
        // задним числом, если ставка комиссии поменяется позже.
        referralFeeOwed: venue.referralFeeAmount,
      },
    });
  }

  /** "Внутренний скоринг сервиса" (§3.23 ТЗ) — компонент "количество
   * успешных броней через платформу" теперь реально считается (было
   * честно не реализовано в Пункте 66 из-за отсутствия этого самого
   * механизма подтверждения). Компонент "отсутствие жалоб" по-прежнему
   * не реализован — системы жалоб в проекте всё ещё нет, честно
   * зафиксировано в /TODO.md. */
  async getCommissionSummary(userId: string, approvedVenueId: string) {
    await this.assertModerator(userId);
    await this.assertVenueExists(approvedVenueId);
    const confirmations = await this.prisma.venueBookingConfirmation.findMany({ where: { approvedVenueId } });
    const totalFeesOwed = sumMoney(confirmations.map((c: { referralFeeOwed: MoneyLike }) => c.referralFeeOwed));
    // Пункт [self-reported-money] 2026-09-05: число и сумма приходят из
    // САМООТЧЁТОВ пользователей. Заведение их не подтверждало и о них не
    // знает; платёжной инфраструктуры в проекте нет. Оператор видел
    // «броней / к оплате» — вид бухгалтерского факта. Происхождение
    // теперь едет вместе с числами, а не остаётся в комментарии к коду.
    return {
      totalBookingsConfirmed: confirmations.length,
      totalFeesOwed,
      basis: 'self-reported' as const,
      distinctReporters: new Set(confirmations.map((c: { confirmedByUserId: string }) => c.confirmedByUserId)).size,
    };
  }

  private async assertVenueExists(approvedVenueId: string) {
    const venue = await this.prisma.approvedVenue.findUnique({ where: { id: approvedVenueId } });
    if (!venue) {
      throw new NotFoundException(`ApprovedVenue ${approvedVenueId} not found`);
    }
    return venue;
  }

  private async assertModerator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isVenueModerator: true } });
    if (!user?.isVenueModerator) {
      throw new ForbiddenException('Требуется роль модератора заведений');
    }
  }
}
