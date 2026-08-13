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
import { FactScope, FactSourceType } from '@prisma/client';

export interface CreatePersonFactInput {
  content: string;
  sourceType: FactSourceType;
  scope?: FactScope;
  projectId?: string;
  confidence?: number;
  source?: {
    fileRef?: string;
    url?: string;
    hasGeoTag?: boolean;
    metadataStripped?: boolean;
  };
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

  private async assertOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}
