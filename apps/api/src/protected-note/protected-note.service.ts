// Пункт 28: ProtectedNoteService (раздел 2 ТЗ, MVP v2 пункт 16) —
// "отдельное защищённое поле — сильный аргумент/факт, который
// пользователь бережёт до критического момента" — ТЗ прямо говорит,
// пользователь ВПИСЫВАЕТ это сам, не AI генерирует. Простой ручной
// CRUD, без AIRouterModule — тот же класс решения, что Evidence
// Gap/Stale Fact Alert/Open Loops (нет AI-вызова), но здесь причина
// другая: не "агрегация уже существующих данных", а "пользовательский
// ввод по определению, не то, что можно вывести откуда-то ещё".
//
// ЧЕСТНО НЕ РЕАЛИЗОВАНО: "Система напоминает о нём [тузе в рукаве],
// когда разговор заходит в тупик" — вторая половина описания в ТЗ.
// "Разговор заходит в тупик" — детектируется только в live-режиме
// (сопровождение разговора в реальном времени, §3.33), который сам
// помечен EXPERIMENTAL и не построен в этом проекте (см. финальный
// аудит ТЗ и предыдущие чекпоинты). Без live-мониторинга разговора
// "напомнить в нужный момент" технически нечем детектировать — заметки
// сохраняются и показываются в карточке разговора (§3.44, уже
// реализовано в ConversationCardService), но проактивное напоминание
// "именно сейчас, потому что разговор зашёл в тупик" — не реализовано,
// зафиксировано явно, не тихо пропущено.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength , IsNotEmpty} from 'class-validator';
import { assertProjectOwnership } from '../common/project-ownership';
import { ProtectedNoteType } from '@prisma/client';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class CreateProtectedNoteInput {
  @IsEnum(ProtectedNoteType) type!: ProtectedNoteType;
  @IsString() @MinLength(1) @MaxLength(4000) content!: string;
  // осмысленно только для FALLBACK_PLAN
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(1000) triggerCondition?: string;
  // осмысленно только для FALLBACK_PLAN
  @IsOptional() @IsInt() @Min(1) @Max(100) planOrder?: number;
}

export class UpdateProtectedNoteInput {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4000) content?: string;
  // null здесь осмыслен — это очистка поля, а не «не трогать».
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(1000) triggerCondition?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) planOrder?: number | null;
}

@Injectable()
export class ProtectedNoteService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, projectId: string, input: CreateProtectedNoteInput) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.protectedNote.create({
      data: {
        projectId,
        type: input.type,
        content: input.content,
        triggerCondition: input.triggerCondition ?? null,
        planOrder: input.planOrder ?? null,
      },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.protectedNote.findMany({
      where: { projectId },
      // FALLBACK_PLAN-заметки — по planOrder (План Б перед Планом В),
      // ACE_IN_THE_HOLE — planOrder всегда null, порядок между собой
      // не имеет смысла (это не последовательность отступления, в
      // отличие от планов Б/В) — сортируется по дате создания как есть.
      orderBy: [{ planOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async update(userId: string, noteId: string, input: UpdateProtectedNoteInput) {
    await this.findOwnedNote(userId, noteId);
    // Пункт [outside-input] 2026-09-04: было `data: input` — тело
    // запроса целиком уходило в UPDATE. Тип `UpdateProtectedNoteInput` —
    // ИНТЕРФЕЙС: он существует только на этапе компиляции, а
    // ValidationPipe в проекте работает без `whitelist` (обоснование —
    // в create-app.ts) и лишние поля не отбрасывает. То есть в теле
    // можно было прислать любой скалярный столбец модели — например
    // `projectId` чужого проекта, — и заметка уезжала туда: проверка
    // владения выше подтверждает право на СТАРУЮ заметку, а не на новое
    // место. Перечисление полей поимённо закрывает это независимо от
    // настроек pipe'а — то же решение, что уже принято в create()
    // несколькими строками выше.
    //
    // `undefined` для Prisma означает «не трогать поле», поэтому
    // частичное обновление работает как прежде; `null` в
    // triggerCondition/planOrder приходит осмысленно — это очистка.
    return this.prisma.protectedNote.update({
      where: { id: noteId },
      data: {
        content: input.content,
        triggerCondition: input.triggerCondition,
        planOrder: input.planOrder,
      },
    });
  }

  async delete(userId: string, noteId: string) {
    await this.findOwnedNote(userId, noteId);
    await this.prisma.protectedNote.delete({ where: { id: noteId } });
    return { deleted: true };
  }

  private async findOwnedNote(userId: string, noteId: string) {
    const note = await this.prisma.protectedNote.findUnique({
      where: { id: noteId },
      include: { project: true },
    });
    if (!note || note.project.ownerId !== userId) {
      throw new NotFoundException(`ProtectedNote ${noteId} not found`);
    }
    return note;
  }
}
