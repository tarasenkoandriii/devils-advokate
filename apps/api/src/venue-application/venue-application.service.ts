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
import { MoneyLike, sumMoney } from '../common/money';
import { SecretsService } from '../secrets/secrets.service';
import { getPlaceDetails, searchByText } from '../venue-recommendation/google-places-client';
import { VenueApplicationStatus } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';

const GOOGLE_PLACES_API_KEY_REF = 'GOOGLE_PLACES_API_KEY';

export interface SubmitApplicationInput {
  name: string;
  address: string;
  phone?: string;
  openingHours?: string[];
  googlePlaceId?: string;
  photoReferences?: string[];
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
      throw new BadRequestException(`VenueApplication ${applicationId} already moderated (status=${application.status})`);
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

  async listApprovedVenues() {
    return this.prisma.approvedVenue.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getApprovedVenue(id: string) {
    const venue = await this.prisma.approvedVenue.findUnique({ where: { id } });
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
    await this.assertVenueExists(approvedVenueId);
    return this.prisma.approvedVenue.update({
      where: { id: approvedVenueId },
      data: { referralFeeAmount },
    });
  }

  /** "Приоритетное размещение... промаркировано как реклама" (§3.22
   * ТЗ) — модератор включает/выключает, TMA обязана визуально отделять
   * такие карточки в публичной выдаче. */
  async setPriorityPartner(userId: string, approvedVenueId: string, isPriorityPartner: boolean) {
    await this.assertModerator(userId);
    await this.assertVenueExists(approvedVenueId);
    return this.prisma.approvedVenue.update({
      where: { id: approvedVenueId },
      data: { isPriorityPartner },
    });
  }

  /** "Комиссия... за бронь, сделанную через сервис" (§3.22 ТЗ) —
   * ЧЕСТНО ограничено самоотчётом пользователя ("я забронировал"), не
   * верифицируемым фактом (нет автоматического бронирования, нет
   * платёжной интеграции — см. подробное обоснование над моделью
   * VenueBookingConfirmation в schema.prisma). Это ЛЕДЖЕР, не система
   * сбора платежей. */
  async confirmBooking(userId: string, approvedVenueId: string, scheduledConversationId?: string) {
    const venue = await this.assertVenueExists(approvedVenueId);
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
    return { totalBookingsConfirmed: confirmations.length, totalFeesOwed };
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
