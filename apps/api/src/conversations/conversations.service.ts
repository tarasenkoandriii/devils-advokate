// Пункт 13: ConversationsService.
//
// Закрывает TODO, который существовал ещё с чекпоинта 1 (пункт 8),
// но ни разу не был реализован ни в одном сервисе до этого прохода:
// раздел 4.6 ТЗ требует, чтобы User.privacyProcessingMode проверялся
// перед EPHEMERAL_SERVER-обработкой (MAXIMUM_PRIVACY — запрещает
// вовсе), но AIRouterService эту проверку никогда не делал — там
// проверяется только ConsentType.EXTERNAL_AI, не privacyProcessingMode
// как таковой. requestTranscription() — первая реальная точка входа,
// где эта проверка нужна буквально (аудио уходит внешнему провайдеру),
// поэтому реализована здесь правильно, а не унаследован тот же пробел.
//
// Пункт 26: assignParticipant() закрывает ещё один пробел, честно
// зафиксированный ещё в Пункте 12/18 (MVP v2, пункт 14 "загрузка
// аудио → транскрибация... сопоставление диаризации фигурантам" —
// сам пункт из раздела 6 ТЗ, не UI-раскрытие сверху) — модель
// ConversationParticipant.personId существовала с самого начала, но
// не было способа её заполнить, TMA UI показывал лейбл диаризации
// ("SPEAKER_00") как есть.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { TranscriptionService, AssemblyAiWebhookPayload } from './transcription.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RequestTranscriptionDto } from './dto/request-transcription.dto';
import { ConversationProcessingStatus } from '@prisma/client';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
    private readonly transcription: TranscriptionService,
  ) {}

  async create(userId: string, projectId: string, dto: CreateConversationDto) {
    await this.assertProjectOwnership(userId, projectId);

    return this.prisma.conversation.create({
      data: {
        projectId,
        sourceType: dto.sourceType,
        occurredAt: new Date(dto.occurredAt),
        durationSeconds: dto.durationSeconds,
        rawFileRef: dto.rawFileRef,
        status: ConversationProcessingStatus.UPLOADED,
      },
    });
  }

  async list(userId: string, projectId: string) {
    await this.assertProjectOwnership(userId, projectId);
    return this.prisma.conversation.findMany({
      where: { projectId },
      orderBy: { occurredAt: 'desc' },
    });
  }

  async get(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversation(userId, conversationId);
    return this.prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: {
        participants: { include: { person: true } },
        transcript: { include: { segments: true } },
      },
    });
  }

  /** Единственная точка входа для запуска транскрибации+диаризации —
   * все приватность-проверки раздела 4.6 ТЗ идут здесь, до вызова
   * TranscriptionService, не после и не опционально. */
  async requestTranscription(userId: string, conversationId: string, dto: RequestTranscriptionDto) {
    const conversation = await this.findOwnedConversation(userId, conversationId);

    if (conversation.status !== ConversationProcessingStatus.UPLOADED) {
      throw new ForbiddenException(
        `Conversation ${conversationId} is not in UPLOADED status (current: ${conversation.status}) — transcription already requested or completed`,
      );
    }

    // §4.6 ТЗ: MAXIMUM_PRIVACY запрещает EPHEMERAL_SERVER-обработку
    // вовсе — облачная транскрибация физически невозможна в этом
    // режиме, не просто "требует лишнего согласия". BALANCED/
    // MAXIMUM_QUALITY допускают её с явным per-operation согласием.
    //
    // Повторный аудит 2026-08-30: те же три проверки, что раньше стояли
    // здесь развёрнуто, теперь живут в ConsentService — потому что их
    // нужно повторять ещё в четырёх местах (загрузка файла, спарринг,
    // чат по материалам), а копия проверки в каждом и была причиной
    // того, что часть точек осталась без неё.
    await this.consent.assertAudioMayLeaveDevice(userId, conversation.projectId);

    const provider = await this.prisma.aIProvider.findUniqueOrThrow({ where: { name: 'assemblyai' } });
    const apiKey = await this.secrets.resolve(provider.credentialRef ?? 'ASSEMBLYAI_API_KEY');

    const webhookUrl = this.buildWebhookUrl(conversationId);
    const { externalJobId } = await this.transcription.submitJob(apiKey, {
      audioUrl: dto.audioUrl,
      webhookUrl,
      languageCode: dto.languageCode,
    });

    const modelVersion = await this.prisma.aIModelVersion.findFirstOrThrow({
      where: { model: { providerId: provider.id } },
    });

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationProcessingStatus.TRANSCRIBING,
        externalTranscriptionJobId: externalJobId,
        transcriptionProviderVersionId: modelVersion.id,
      },
    });
  }

  /** Обработчик входящего webhook от AssemblyAI — не защищён
   * TelegramAuthGuard (AssemblyAI не может пройти Telegram-авторизацию),
   * поэтому сопоставление идёт по externalTranscriptionJobId, не по
   * userId. Проверка подлинности запроса (webhook signing secret) —
   * честно не реализована на этом проходе, см. README "Пункт 13",
   * известное упрощение. */
  async handleTranscriptionWebhook(payload: AssemblyAiWebhookPayload) {
    // Финальный аудит 2026-08-30 — реальный вебхук AssemblyAI несёт только
    // transcript_id/status, без данных; полный результат — отдельным GET.
    // Явная проверка вместо доверия типу интерфейса: если поле пустое
    // (баг у отправителя, руками собранный запрос через guard), не даём
    // Prisma findFirst() трактовать undefined как «фильтра нет» и
    // возвращать первую попавшуюся запись — см. комментарий в
    // transcription.service.ts у AssemblyAiWebhookPayload.
    if (!payload.transcript_id) {
      return { acknowledged: true, matched: false };
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: { externalTranscriptionJobId: payload.transcript_id },
    });
    if (!conversation) {
      // Не бросаем 404 наружу как есть — AssemblyAI не обязан знать
      // внутреннюю структуру наших ошибок, просто логируем и отвечаем
      // 200, иначе AssemblyAI будет бесконечно ретраить webhook на
      // задачу, которая у нас уже не существует (например Conversation
      // удалена пользователем через Privacy Center до завершения job).
      return { acknowledged: true, matched: false };
    }

    const provider = await this.prisma.aIProvider.findUniqueOrThrow({ where: { name: 'assemblyai' } });
    const apiKey = await this.secrets.resolve(provider.credentialRef ?? 'ASSEMBLYAI_API_KEY');
    const result = await this.transcription.getTranscriptResult(apiKey, payload.transcript_id);

    if (result.status === 'error') {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: ConversationProcessingStatus.FAILED },
      });
      return { acknowledged: true, matched: true };
    }

    const parsed = this.transcription.parseTranscriptResult(result);

    // Уникальные диаризационные лейблы → ConversationParticipant.
    // Первый встреченный спикер помечается isSelf=true эвристически
    // НЕ ЗДЕСЬ — сопоставление "какой лейбл диаризации — это сам
    // пользователь" требует либо явного выбора пользователем в UI
    // (прослушать и отметить), либо более сложной эвристики (например
    // сверка с голосовым отпечатком) — ни то ни другое не реализовано
    // на этом проходе. Все участники создаются с isSelf=false,
    // personId=null — сопоставление конкретному Person или пользователю
    // происходит отдельным вызовом UI после того, как транскрипт готов
    // и пользователь может его просмотреть.
    const uniqueLabels = [...new Set(parsed.segments.map((s) => s.diarizationLabel))];
    const participantsByLabel = new Map<string, string>(); // label -> ConversationParticipant.id

    for (const label of uniqueLabels) {
      const participant = await this.prisma.conversationParticipant.upsert({
        where: { conversationId_diarizationLabel: { conversationId: conversation.id, diarizationLabel: label } },
        update: {},
        create: { conversationId: conversation.id, diarizationLabel: label },
      });
      participantsByLabel.set(label, participant.id);
    }

    // ПОВТОРНЫЙ АУДИТ 2026-08-30 — идемпотентность. Transcript.conversationId
    // объявлен @unique, а здесь стоял безусловный create(). AssemblyAI
    // ретраит вебхук на любой не-2xx ответ, и повторная доставка (штатное
    // поведение провайдера, а не экзотика) роняла обработчик на P2002 →
    // 500 → новый ретрай → бесконечный цикл ошибок на одном разговоре.
    // upsert по conversationId: повтор перезаписывает язык и не создаёт
    // второй транскрипт.
    const transcript = await this.prisma.transcript.upsert({
      where: { conversationId: conversation.id },
      update: { language: parsed.language },
      create: {
        conversationId: conversation.id,
        language: parsed.language,
      },
    });

    // Сегменты при повторной доставке нужно снести, иначе createMany
    // ниже добавит второй комплект к первому и транскрипт удвоится.
    await this.prisma.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });

    if (parsed.segments.length > 0) {
      await this.prisma.transcriptSegment.createMany({
        data: parsed.segments.map((s) => ({
          transcriptId: transcript.id,
          participantId: participantsByLabel.get(s.diarizationLabel) ?? null,
          text: s.text,
          startMs: s.startMs,
          endMs: s.endMs,
          confidence: s.confidence,
        })),
      });
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: ConversationProcessingStatus.TRANSCRIBED },
    });

    return { acknowledged: true, matched: true };
  }

  /** Загрузка аудио клиентом — потоковая передача без буферизации,
   * возвращает URL, готовый для requestTranscription(). Отдельный
   * метод от requestTranscription() намеренно: "загрузить файл" и
   * "запустить транскрибацию" — разные по стоимости и обратимости
   * операции (первая почти бесплатна и мгновенна, вторая запускает
   * платный внешний job) — клиент может захотеть посмотреть на
   * загруженный файл/подтвердить перед стартом обработки, не всегда
   * запускать её автоматически сразу по факту загрузки. */
  async streamUploadAudio(userId: string, conversationId: string, fileStream: ReadableStream<Uint8Array>) {
    const conversation = await this.findOwnedConversation(userId, conversationId);

    // ПОВТОРНЫЙ АУДИТ 2026-08-30: здесь НЕ было ни одной приватность-
    // проверки — только владение разговором. А байты файла уходят
    // AssemblyAI именно на этом шаге; проверки в requestTranscription()
    // срабатывали, когда аудио уже лежало у провайдера. То есть режим
    // MAXIMUM_PRIVACY и оба согласия обходились простым порядком
    // вызовов: upload без transcribe.
    await this.consent.assertAudioMayLeaveDevice(userId, conversation.projectId);

    const provider = await this.prisma.aIProvider.findUniqueOrThrow({ where: { name: 'assemblyai' } });
    const apiKey = await this.secrets.resolve(provider.credentialRef ?? 'ASSEMBLYAI_API_KEY');

    const uploadUrl = await this.transcription.streamUpload(apiKey, fileStream);
    return { audioUrl: uploadUrl };
  }

  private async findOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      // NotFoundException для обоих случаев (не существует / существует,
      // но не ваш) — тот же принцип, что assertProjectOwnership()
      // в common/project-ownership.ts, не копирую его реализацию
      // напрямую только потому, что здесь ownership проверяется через
      // Conversation → Project, не напрямую по projectId параметру.
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }

  /** Пункт 26 — закрывает пробел, честно зафиксированный ещё в Пункте
   * 12/18: TMA UI показывал лейбл диаризации ("SPEAKER_00") как есть,
   * не было способа сопоставить его конкретному Person. isSelf
   * взаимоисключающий с personId — сопоставление либо "это фигурант
   * X", либо "это сам пользователь", не оба сразу (проверяется здесь,
   * не полагаемся на то, что клиент пришлёт корректную комбинацию). */
  async assignParticipant(
    userId: string,
    participantId: string,
    input: { personId?: string; isSelf?: boolean },
  ) {
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { id: participantId },
      include: { conversation: { include: { project: true } } },
    });
    if (!participant || participant.conversation.project.ownerId !== userId) {
      throw new NotFoundException(`ConversationParticipant ${participantId} not found`);
    }

    if (input.personId && input.isSelf) {
      throw new ForbiddenException(
        'A participant cannot be both isSelf and mapped to a specific personId — choose one',
      );
    }

    if (input.personId) {
      const person = await this.prisma.person.findFirst({
        where: { id: input.personId, createdByUserId: userId },
      });
      if (!person) {
        throw new NotFoundException(`Person ${input.personId} not found`);
      }
    }

    return this.prisma.conversationParticipant.update({
      where: { id: participantId },
      data: {
        personId: input.isSelf ? null : (input.personId ?? null),
        isSelf: input.isSelf ?? false,
      },
    });
  }

  private async assertProjectOwnership(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  private buildWebhookUrl(conversationId: string): string {
    const base = process.env.API_PUBLIC_BASE_URL;
    if (!base) {
      throw new Error(
        'API_PUBLIC_BASE_URL is not set — required to build a webhook URL AssemblyAI can call back',
      );
    }
    return `${base}/conversations/webhook/transcription?conversationId=${conversationId}`;
  }
}
