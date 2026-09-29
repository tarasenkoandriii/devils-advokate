// Пункт 58: PersonFactService (§4.2/§3.19 ТЗ) — минимальный
// facts-list UI (предварительный шаг) + предупреждение о геометках
// EXIF, пункт 29 v3-роадмапа. По прямому запросу.
//
// РЕАЛЬНАЯ НАХОДКА, БОЛЕЕ ФУНДАМЕНТАЛЬНАЯ, ЧЕМ ОЖИДАЛОСЬ: за весь
// проект `PersonFact.create()` не вызывался НИ РАЗУ ни одним сервисом
// (проверено grep по всему src/ перед началом работы) — факт-система
// (§4.2) существовала только для ЧТЕНИЯ (Steelman, коммуникационный
// профиль, поиск прецедентов и другие уже построенные фичи читают
// PersonFact), но создавать факты через приложение было НЕЛЬЗЯ вообще.
// Не "нет facts-list UI" — глубже: не было даже backend-эндпоинта
// создания. Закрывается здесь впервые за весь проект.
//
// ГЕОМЕТКИ (§3.19 ТЗ) — ПРОВЕРКА ЦЕЛИКОМ НА КЛИЕНТЕ, backend НИКОГДА
// не видит сырой файл (ни сейчас, ни для этой проверки) — hasGeoTag/
// metadataStripped приходят от TMA УЖЕ ВЫЧИСЛЕННЫМИ (см.
// apps/tma/src/lib/exif-check.ts), сервис только персистит результат,
// не пересчитывает и не может пересчитать (файла у него никогда не
// было). Тот же принцип locality, что у fileRef/url — задокументирован
// над полями в schema.prisma.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FactScope, FactSourceType } from '@prisma/client';
import { FactStatus } from '@prisma/client';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class PersonFactSourceInput {
  @IsOptional() @IsString() @MaxLength(2000) fileRef?: string;
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsBoolean() hasGeoTag?: boolean;
  @IsOptional() @IsBoolean() metadataStripped?: boolean;
}

export class CreatePersonFactInput {
  @IsString() @MinLength(1) @MaxLength(4000) content!: string;
  @IsEnum(FactSourceType) sourceType!: FactSourceType;
  @IsOptional() @IsEnum(FactScope) scope?: FactScope;
  @IsOptional() @IsString() @MaxLength(100) projectId?: string;
  // Уверенность — доля, а не «сколько не жалко»: значение вне 0..1
  // молча искажало бы всё, что по ней считается.
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  // Вложенный объект требует @ValidateNested + @Type: без них
  // class-validator внутрь не заглядывает вообще.
  @IsOptional() @ValidateNested() @Type(() => PersonFactSourceInput) source?: PersonFactSourceInput;
}

@Injectable()
export class PersonFactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, personId: string, input: CreatePersonFactInput) {
    await this.assertOwnedPerson(userId, personId);
    if (!input.content.trim()) {
      throw new BadRequestException('content не может быть пустым');
    }

    const scope = input.scope ?? FactScope.PROJECT;
    // "Обязателен при scope=PROJECT, null для остальных scope-значений"
    // (буквально комментарий над полем в schema.prisma) — инвариант,
    // проверяемый в service-слое, не схемой.
    if (scope === FactScope.PROJECT && !input.projectId) {
      throw new BadRequestException('projectId обязателен для scope=PROJECT');
    }
    if (scope !== FactScope.PROJECT && input.projectId) {
      throw new BadRequestException(`projectId не должен указываться для scope=${scope}`);
    }
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, ownerId: userId } });
      if (!project) {
        throw new NotFoundException(`Project ${input.projectId} not found`);
      }
    }

    const fact = await this.prisma.personFact.create({
      data: {
        personId,
        projectId: scope === FactScope.PROJECT ? input.projectId : null,
        scope,
        content: input.content.trim(),
        sourceType: input.sourceType,
        confidence: input.confidence ?? null,
      },
    });

    if (input.source && (input.source.fileRef || input.source.url)) {
      await this.prisma.factSource.create({
        data: {
          personFactId: fact.id,
          fileRef: input.source.fileRef ?? null,
          url: input.source.url ?? null,
          hasGeoTag: input.source.hasGeoTag ?? null,
          metadataStripped: input.source.metadataStripped ?? null,
        },
      });
    }

    return this.prisma.personFact.findUnique({ where: { id: fact.id }, include: { sources: true } });
  }

  async listForPerson(userId: string, personId: string) {
    await this.assertOwnedPerson(userId, personId);
    return this.prisma.personFact.findMany({
      where: { personId },
      include: { sources: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Пункт [no-correction] 2026-09-05 — запись о человеке можно
   * подтвердить, оспорить, признать неактуальной и удалить.
   *
   * НАЙДЕНО ИЗМЕРЕНИЕМ. У `PersonFact` было ровно два действия: создать
   * и прочитать. Ни исправить, ни удалить, ни оспорить — при том что:
   *
   *  • `FactStatus` в схеме знает DISPUTED и EXPIRED, и ТРИ сервиса на
   *    них ветвятся (`EvidenceGapService` объявляет факт
   *    «противоречивым», `SourceConflictService` и `StaleFactService`
   *    исключают истёкшие). Выставить эти состояния не мог никто:
   *    поиск по всей кодовой базе не находит ни одной записи в это поле.
   *    Ветки существовали, срабатывать не могли никогда.
   *  • `lastVerifiedAt` не записывался НИГДЕ. Значит «давно не
   *    подтверждался» считалось от даты создания и навсегда: продукт
   *    звал перепроверить факт и не давал способа сказать, что
   *    перепроверил. Предупреждение, которое нельзя снять, перестают
   *    читать — и вместе с ним перестают читать те, которые снять
   *    стоило бы.
   *
   * ЧЕГО ЭТО НЕ ДЕЛАЕТ, и это сказано человеку на экране: удаление факта
   * не убирает выводы, уже построенные с его участием. Черты профиля и
   * прецеденты ссылаются на источник ТЕКСТОМ (архитектурное решение
   * §3.11, не недосмотр) — связать их с конкретным фактом нечем.
   * Обещать обратное было бы враньём того же рода, что разобрано в
   * пункте [candidate-rights]. */
  async confirm(userId: string, personId: string, factId: string) {
    await this.assertOwnedFact(userId, personId, factId);
    return this.prisma.personFact.update({
      where: { id: factId },
      // Подтверждение — это ещё и возврат из «оспорено»: человек
      // проверил и говорит, что всё-таки так.
      data: { lastVerifiedAt: new Date(), status: FactStatus.ACTIVE },
      include: { sources: true },
    });
  }

  async setStatus(userId: string, personId: string, factId: string, status: FactStatus) {
    await this.assertOwnedFact(userId, personId, factId);
    return this.prisma.personFact.update({
      where: { id: factId },
      data: { status },
      include: { sources: true },
    });
  }

  async remove(userId: string, personId: string, factId: string): Promise<{ deleted: true }> {
    await this.assertOwnedFact(userId, personId, factId);
    await this.prisma.personFact.delete({ where: { id: factId } });
    return { deleted: true };
  }

  private async assertOwnedFact(userId: string, personId: string, factId: string) {
    await this.assertOwnedPerson(userId, personId);
    const fact = await this.prisma.personFact.findFirst({ where: { id: factId, personId } });
    if (!fact) {
      throw new NotFoundException(`PersonFact ${factId} not found`);
    }
    return fact;
  }

  private async assertOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}
