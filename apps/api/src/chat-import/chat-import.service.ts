// Пункт 61: ChatImportService (§3.29 ТЗ) — "Импорт текстовых
// переписок", v4-роадмап (пункт 47 общего списка). По прямому запросу.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ — "тот же аналитический конвейер, что и для
// аудио" (буквально ТЗ) реализовано БУКВАЛЬНО: не строится
// параллельная модель данных под текстовые переписки, а напрямую
// заполняются Conversation/ConversationParticipant/Transcript/
// TranscriptSegment — те же модели, что уже использует аудио-конвейер
// (Пункт 13). Подтверждено перед началом работы: ни один downstream-
// сервис (извлечение аргументов, детектор манипуляций, анализ
// расхождений и другие уже построенные AI-фичи) не фильтрует и не
// проверяет Conversation.sourceType — все они читают только
// TranscriptSegment/ConversationParticipant, значит работают на
// импортированной переписке ровно так же, как на транскрибированном
// аудио, без единой строчки новой интеграции.
//
// НЕТ АСИНХРОННОЙ ТРАНСКРИБАЦИИ — сообщения уже текст, шаг
// TRANSCRIBING (как у аудио, Пункт 13) не нужен: Conversation
// создаётся сразу в статусе TRANSCRIBED.
//
// "ТЕКСТ ПЕРЕПИСКИ ОБРАБАТЫВАЕТСЯ ЛОКАЛЬНО, НА СЕРВЕР УХОДЯТ ТОЛЬКО
// ПРОИЗВОДНЫЕ" — buкально ТЗ, тот же принцип locality, что у всего
// проекта. Парсинг .txt-экспорта WhatsApp — ЦЕЛИКОМ на клиенте (см.
// apps/tma/src/lib/chat-import-parse.ts), сюда приходит уже СТРУКТУРИ-
// РОВАННЫЙ список сообщений (sender/text/timestamp), не сырой текст
// файла экспорта как единая строка — то же самое разделение "файл
// остаётся локально, сервер видит только результат разбора", что уже
// применялось к EXIF (Пункт 58) и PPTX (Пункт 60).
//
// СОГЛАСИЕ — только ConsentType.RECORDING ("явный дисклеймер перед
// записью/загрузкой", тот же принцип, что уже применяется к аудио в
// ConversationsService.requestTranscription()), НЕ EPHEMERAL_SERVER:
// то согласие защищает передачу аудио ВНЕШНЕМУ STT-провайдеру
// (AssemblyAI) — здесь такой передачи нет вообще, текст уже текст, не
// нуждается в распознавании речи.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType, ConversationProcessingStatus, ConversationSourceType } from '@prisma/client';

export interface ImportChatMessage {
  sender: string;
  text: string;
  timestampMs: number;
}

export interface ImportChatInput {
  messages: ImportChatMessage[];
  selfSenderName: string;
  rawFileRef?: string;
}

@Injectable()
export class ChatImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  async importChat(userId: string, projectId: string, input: ImportChatInput) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if (input.messages.length === 0) {
      throw new BadRequestException('messages не может быть пустым');
    }

    const distinctSenders = [...new Set(input.messages.map((m) => m.sender))];
    if (!distinctSenders.includes(input.selfSenderName)) {
      throw new BadRequestException(`selfSenderName "${input.selfSenderName}" не найден среди отправителей переписки`);
    }

    // Раздел 2 ТЗ: "явный дисклеймер перед записью/загрузкой" — тот же
    // принцип, что уже применяется к аудио.
    await this.consent.requireConsent(userId, ConsentType.RECORDING, projectId);

    const firstTimestampMs = Math.min(...input.messages.map((m) => m.timestampMs));

    return this.prisma.$transaction(async (tx: typeof this.prisma) => {
      const conversation = await tx.conversation.create({
        data: {
          projectId,
          sourceType: ConversationSourceType.TEXT_IMPORT,
          status: ConversationProcessingStatus.TRANSCRIBED,
          occurredAt: new Date(firstTimestampMs),
          rawFileRef: input.rawFileRef ?? null,
        },
      });

      const participantByName = new Map<string, string>(); // sender name -> participantId
      for (let i = 0; i < distinctSenders.length; i++) {
        const name = distinctSenders[i];
        const participant = await tx.conversationParticipant.create({
          data: {
            conversationId: conversation.id,
            diarizationLabel: `IMPORTED_${i}`,
            isSelf: name === input.selfSenderName,
          },
        });
        participantByName.set(name, participant.id);
      }

      const transcript = await tx.transcript.create({ data: { conversationId: conversation.id } });

      for (const msg of input.messages) {
        await tx.transcriptSegment.create({
          data: {
            transcriptId: transcript.id,
            participantId: participantByName.get(msg.sender) ?? null,
            text: msg.text,
            // Текстовое сообщение не имеет длительности — startMs/endMs
            // совпадают, честно отражает природу данных, не выдумывает
            // произвольную "длительность реплики".
            startMs: msg.timestampMs - firstTimestampMs,
            endMs: msg.timestampMs - firstTimestampMs,
          },
        });
      }

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        include: { participants: true, transcript: { include: { segments: true } } },
      });
    });
  }
}
