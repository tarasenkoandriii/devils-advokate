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

import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { requireAIProvider } from '../common/require-provider';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { TranscriptionService, type ParsedTranscript } from './transcription.service';
import { SttService, sttJobIdVariants } from '../stt/stt.service';
import { parseSttWebhookPayload } from '../stt/stt-webhook-payload';
import { AudioBlobService } from './audio-blob.service';
import { ParalinguisticsService } from './paralinguistics.service';
import { MEDIA_LEASE_MAX_AGE_MS } from '../ai-router/ai-provider-client';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RequestTranscriptionDto } from './dto/request-transcription.dto';
import { ConversationProcessingStatus } from '@prisma/client';
import { publicApiBaseUrl } from '../common/public-base-url';

@Injectable()
export class ConversationsService implements OnModuleInit {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
    private readonly transcription: TranscriptionService,
    private readonly stt: SttService,
    private readonly audioBlob: AudioBlobService,
    private readonly paralinguistics: ParalinguisticsService,
  ) {}

  onModuleInit(): void {
    // Проводка release-функции в ParalinguisticsService — инъекция
    // функцией вместо forwardRef: циклическая DI ради одного вызова
    // была бы дороже, чем это (см. комментарий у wireRelease).
    this.paralinguistics.wireRelease((conversationId, count) =>
      this.releaseMediaConsumer(conversationId, count ?? 1),
    );
  }

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

    // Пункт [blob-upload] 2026-08-31 — два возможных источника файла,
    // выбор явный, а не «что нашлось». Обоснование — в
    // dto/request-transcription.dto.ts, реализация — в
    // resolveAudioUrl() ниже.
    const audioUrl = await this.resolveAudioUrl(conversation, dto);

    // Пункт [stt-multi] 2026-09-02: провайдера выбирает ЯЗЫК записи
    // (ru/uk → Soniox, en → AssemblyAI), а строка AIProvider нужна ради
    // версии модели в телеметрии. Провайдер, который реально возьмёт
    // задачу, известен только после submitWebhookJob — фоллбек мог
    // увести её к запасному, и это записано в самом идентификаторе.
    const provider = await requireAIProvider(this.prisma, 'assemblyai');

    // Повторный аудит 2026-09-01: версия модели резолвится ДО платного
    // submitJob. Раньше порядок был обратный — при отсутствии строки
    // AIModelVersion задача у AssemblyAI уже была поставлена (и
    // оплачена), а запрос падал. Плюс orderBy: findFirst без него
    // отдаёт строки в непредсказуемом порядке — тот же недетерминизм,
    // который уже чинили в AIRouter.resolveModelVersion.
    const modelVersion = await this.prisma.aIModelVersion.findFirst({
      where: { model: { providerId: provider.id } },
      orderBy: { createdAt: 'asc' },
    });
    if (!modelVersion) {
      throw new ServiceUnavailableException(
        `Для провайдера «${provider.name}» в базе нет ни одной модели (AIModelVersion). ` +
          'Это конфигурация, а не сбой провайдера — выполните `npm run prisma:seed` против этой базы.',
      );
    }

    const webhookUrl = this.buildWebhookUrl(conversationId);
    const { storedId, provider: usedProvider } = await this.stt.submitWebhookJob({
      audioUrl,
      webhookUrl,
      languageCode: dto.languageCode,
      diarize: true,
      uploadedTo: dto.sttProvider,
    });

    // Телеметрия должна называть ТОГО, кто реально распознавал: задачу
    // мог взять другой провайдер (по языку или как запасной). Если его
    // строки в базе нет — оставляем версию, найденную выше, а не роняем
    // уже поставленную (и оплаченную) задачу.
    const usedModelVersion =
      usedProvider === provider.name
        ? modelVersion
        : (await this.prisma.aIModelVersion.findFirst({
            where: { model: { provider: { name: usedProvider } } },
            orderBy: { createdAt: 'asc' },
          })) ?? modelVersion;

    // Пункт [multimodal] §7.2 — счётчик потребителей файла. AssemblyAI
    // — всегда потребитель №1 (для blob-пути); паралингвистика — №2,
    // если включена. Файл удаляется на нуле, а не по первому вебхуку —
    // иначе паралингвистический проход не получил бы файла никогда.
    const hasBlob = conversation.audioBlobPathname != null; // != null: у фейков в тестах поле бывает undefined
    const wantsParalinguistics = dto.enableParalinguistics === true;
    if (wantsParalinguistics && !hasBlob) {
      throw new ForbiddenException(
        'Паралингвистика требует файла в хранилище (прямая загрузка): потоковый путь файла не оставляет, комментировать подачу не по чему',
      );
    }

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationProcessingStatus.TRANSCRIBING,
        externalTranscriptionJobId: storedId,
        transcriptionProviderVersionId: usedModelVersion.id,
        paralinguisticsEnabled: wantsParalinguistics,
        pendingMediaConsumers: hasBlob ? (wantsParalinguistics ? 2 : 1) : 0,
        mediaLeaseExpiresAt: hasBlob ? new Date(Date.now() + MEDIA_LEASE_MAX_AGE_MS) : null,
      },
    });
  }

  /** Обработчик входящего webhook от AssemblyAI — не защищён
   * TelegramAuthGuard (AssemblyAI не может пройти Telegram-авторизацию),
   * поэтому сопоставление идёт по externalTranscriptionJobId, не по
   * userId. Проверка подлинности запроса (webhook signing secret) —
   * честно не реализована на этом проходе, см. README "Пункт 13",
   * известное упрощение. */
  async handleTranscriptionWebhook(rawPayload: unknown) {
    // Пункт [stt-multi] 2026-09-02: тело вебхука разное у провайдеров
    // (transcript_id против id), разбор — один на всех.
    const payload = parseSttWebhookPayload(rawPayload);
    // Финальный аудит 2026-08-30 — реальный вебхук AssemblyAI несёт только
    // transcript_id/status, без данных; полный результат — отдельным GET.
    // Явная проверка вместо доверия типу интерфейса: если поле пустое
    // (баг у отправителя, руками собранный запрос через guard), не даём
    // Prisma findFirst() трактовать undefined как «фильтра нет» и
    // возвращать первую попавшуюся запись — см. комментарий в
    // transcription.service.ts у AssemblyAiWebhookPayload.
    if (!payload.externalJobId) {
      return { acknowledged: true, matched: false };
    }

    // Ищем по обоим написаниям: задачи до Пункта [stt-multi] лежат без
    // префикса провайдера, новые — с ним. Иначе результат уже
    // оплаченной задачи, поставленной до выката, потерялся бы.
    const conversation = await this.prisma.conversation.findFirst({
      where: { externalTranscriptionJobId: { in: sttJobIdVariants(payload.externalJobId) } },
    });
    if (!conversation) {
      // Не бросаем 404 наружу как есть — AssemblyAI не обязан знать
      // внутреннюю структуру наших ошибок, просто логируем и отвечаем
      // 200, иначе AssemblyAI будет бесконечно ретраить webhook на
      // задачу, которая у нас уже не существует (например Conversation
      // удалена пользователем через Privacy Center до завершения job).
      return { acknowledged: true, matched: false };
    }

    // Провайдера определяет ПРЕФИКС сохранённого идентификатора, а не
    // язык: задачу мог взять запасной провайдер.
    let parsed: ParsedTranscript | null = null;
    let failureReason: string | null = null;
    try {
      parsed = await this.stt.fetchResult(conversation.externalTranscriptionJobId ?? payload.externalJobId);
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }

    if (failureReason !== null || parsed === null) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: ConversationProcessingStatus.FAILED },
      });
      // Пункт [blob-upload] 2026-08-31: удаление ОБЯЗАТЕЛЬНО и на ветке
      // ошибки тоже — транзитный буфер не должен превращаться в
      // хранилище. Пункт [multimodal] §7.2: теперь через счётчик
      // потребителей; при ошибке транскрибации паралингвистика тоже не
      // состоится (ей нужен транскрипт), поэтому освобождаются ОБА
      // резерва разом.
      await this.releaseMediaConsumer(
        conversation.id,
        conversation.paralinguisticsEnabled ? 2 : 1,
      );
      return { acknowledged: true, matched: true };
    }


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

    // Пункт [multimodal] §7.1 — паралингвистический проход запускается
    // строго ПОСЛЕ записи транскрипта: модель комментирует известные
    // сегменты, не транскрибирует заново. Если постановка не удалась,
    // зарезервированный под неё потребитель файла освобождается тут же
    // — иначе blob висел бы до сторожевой.
    let paralinguisticsReleases = 0;
    if (conversation.paralinguisticsEnabled && conversation.audioBlobPathname) {
      try {
        await this.paralinguistics.enqueueForConversation(conversation.id);
      } catch (err) {
        paralinguisticsReleases = 1;
        this.logger.warn(
          `Паралингвистика для разговора ${conversation.id} не запустилась: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Пункт [blob-upload] → [multimodal] §7.2: раньше файл удалялся
    // сразу по вебхуку; теперь — декремент потребителя AssemblyAI, и
    // физическое удаление происходит на нуле. Для разговора без
    // паралингвистики поведение НЕ меняется: 1 → 0 → удаление тем же
    // вебхуком. Стоит ПОСЛЕ записи транскрипта намеренно: потерять
    // можно файл, но не результат.
    await this.releaseMediaConsumer(conversation.id, 1 + paralinguisticsReleases);

    return { acknowledged: true, matched: true };
  }

  /** Пункт [multimodal] §7.2 — единственная точка удаления файла.
   * Декремент счётчика потребителей; на нуле — физическое удаление
   * blob'а и обнуление ссылок. Инвариант «pathname в БД ⇒ файл
   * существует» сохраняется; инвариант «удаляется сразу по завершении
   * транскрибации» ОСЛАБЛЕН до «удаляется по завершении всех
   * потребителей, но не позже MEDIA_LEASE_MAX_AGE» — осознанное
   * расширение окна хранения, отражённое в тексте согласия
   * EPHEMERAL_SERVER, не только здесь. */
  async releaseMediaConsumer(conversationId: string, count = 1): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { pendingMediaConsumers: true, audioBlobPathname: true },
    });
    if (!conversation) return;

    const remaining = Math.max(0, (conversation.pendingMediaConsumers ?? 0) - count);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { pendingMediaConsumers: remaining },
    });

    if (remaining === 0 && conversation.audioBlobPathname) {
      await this.audioBlob.deleteByPathname(conversation.audioBlobPathname);
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          audioBlobPathname: null,
          audioBlobBytes: null,
          audioBlobContentType: null,
          mediaLeaseExpiresAt: null,
        },
      });
    }
  }

  /** Сторожевая §7.2: потребители зависли дольше MEDIA_LEASE_MAX_AGE →
   * принудительное удаление файла и обнуление счётчика. Утечка файла
   * хуже потерянного анализа — приоритет прямо здесь. Вызывается из
   * POST /internal/ai-jobs/reap (pg_cron). */
  async reapExpiredMediaLeases(): Promise<{ mediaReaped: number }> {
    const expired = await this.prisma.conversation.findMany({
      where: {
        pendingMediaConsumers: { gt: 0 },
        mediaLeaseExpiresAt: { lt: new Date() },
      },
      select: { id: true, audioBlobPathname: true },
    });
    for (const conversation of expired) {
      if (conversation.audioBlobPathname) {
        await this.audioBlob.deleteByPathname(conversation.audioBlobPathname);
      }
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingMediaConsumers: 0,
          audioBlobPathname: null,
          audioBlobBytes: null,
          audioBlobContentType: null,
          mediaLeaseExpiresAt: null,
        },
      });
    }
    return { mediaReaped: expired.length };
  }

  /** Загрузка аудио клиентом — потоковая передача без буферизации,
   * возвращает URL, готовый для requestTranscription(). Отдельный
   * метод от requestTranscription() намеренно: "загрузить файл" и
   * "запустить транскрибацию" — разные по стоимости и обратимости
   * операции (первая почти бесплатна и мгновенна, вторая запускает
   * платный внешний job) — клиент может захотеть посмотреть на
   * загруженный файл/подтвердить перед стартом обработки, не всегда
   * запускать её автоматически сразу по факту загрузки. */
  async streamUploadAudio(
    userId: string,
    conversationId: string,
    fileStream: ReadableStream<Uint8Array>,
    languageCode?: string | null,
  ) {
    const conversation = await this.findOwnedConversation(userId, conversationId);

    // ПОВТОРНЫЙ АУДИТ 2026-08-30: здесь НЕ было ни одной приватность-
    // проверки — только владение разговором. А байты файла уходят
    // AssemblyAI именно на этом шаге; проверки в requestTranscription()
    // срабатывали, когда аудио уже лежало у провайдера. То есть режим
    // MAXIMUM_PRIVACY и оба согласия обходились простым порядком
    // вызовов: upload без transcribe.
    await this.consent.assertAudioMayLeaveDevice(userId, conversation.projectId);

    // РЕВЬЮ 2026-09-02: байты уходили ЖЁСТКО в AssemblyAI, а задача
    // дальше маршрутизировалась по языку — для ru/uk она уезжала в
    // Soniox со ссылкой вида cdn.assemblyai.com/upload/…, доступной
    // «только серверам AssemblyAI». Теперь загрузка идёт тому же
    // провайдеру, который возьмёт задачу, и его имя возвращается
    // клиенту: requestTranscription получит его как sttProvider и не
    // будет пытаться отдать чужую ссылку соседу.
    const { audioUrl, provider: sttProvider } = await this.stt.uploadAudio(fileStream, languageCode ?? null);
    return { audioUrl, sttProvider };
  }

  /** Пункт [blob-upload] 2026-08-31 — подтверждение прямой загрузки в
   * Blob (шаг 3 протокола, см. шапку audio-blob.service.ts). Тонкая
   * делегация: вся логика проверок в AudioBlobService, здесь метод
   * существует только для того, чтобы у контроллера был один сервис
   * разговоров, а не два. */
  async confirmAudioUpload(userId: string, conversationId: string, input: { pathname: string }) {
    return this.audioBlob.confirmUpload(userId, conversationId, input);
  }

  /** Выбор источника аудио для AssemblyAI. Оба варианта валидны, но
   * ровно один за раз — см. dto/request-transcription.dto.ts.
   *
   * Порядок проверок важен: сначала отсекается неоднозначность, потом
   * пустота. Если сделать наоборот, запрос с двумя источниками прошёл
   * бы «успешно», молча выбрав один. */
  private async resolveAudioUrl(
    conversation: { id: string; audioBlobPathname: string | null },
    dto: RequestTranscriptionDto,
  ): Promise<string> {
    const explicitUrl = dto.audioUrl?.trim();

    if (explicitUrl && conversation.audioBlobPathname) {
      throw new ForbiddenException(
        'Для разговора одновременно указан audioUrl и загружен файл в хранилище — неясно, что расшифровывать. ' +
          'Либо не передавайте audioUrl (будет использован загруженный файл), либо загрузите файл заново.',
      );
    }

    if (explicitUrl) return explicitUrl;

    if (conversation.audioBlobPathname) {
      // Подписанная ссылка живёт часы, не вечно, и не существует нигде,
      // кроме тела запроса к AssemblyAI — в БД она не сохраняется
      // намеренно: хранить действующую ссылку на приватный файл рядом
      // с самим фактом его существования означало бы свести приватность
      // стора к нулю.
      return this.audioBlob.presignForTranscription(conversation.audioBlobPathname);
    }

    throw new ForbiddenException(
      'Для разговора нет аудио: сначала загрузите файл (POST /conversations/:id/audio-upload-token → загрузка в хранилище → ' +
        'POST /conversations/:id/audio-blob) либо передайте готовый audioUrl.',
    );
  }

  /** Пункт [multimodal] §7.3, фаза F — сигналы подачи для панели
   * паралингвистики в TMA. Возвращаются оба паралингвистических типа
   * с текстом сегмента; без нового AI-вызова — только чтение. */
  async listDeliverySignals(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversation(userId, conversationId);
    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: { in: ['DELIVERY_INCONGRUENCE', 'EMOTIONAL_SHIFT'] },
        transcriptSegment: { transcript: { conversationId: conversation.id } },
        // Только сигналы с paralinguisticChannel или из паралингвистики:
        // EMOTIONAL_SHIFT умеет создавать и текстовый конвейер, панель
        // подачи показывает только «как сказано».
        paralinguisticChannel: { not: null },
      },
      include: { transcriptSegment: { select: { text: true, startMs: true, endMs: true } } },
      orderBy: { transcriptSegment: { startMs: 'asc' } },
    });
    return signals.map((s) => ({
      id: s.id,
      signalType: s.signalType,
      channel: s.paralinguisticChannel,
      confidence: s.confidence,
      segmentText: s.transcriptSegment?.text ?? '',
      startMs: s.transcriptSegment?.startMs ?? 0,
      endMs: s.transcriptSegment?.endMs ?? 0,
    }));
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
    // 2026-08-31: разбор и нормализация переехали в
    // common/public-base-url.ts — три копии этой склейки расходились
    // между собой, и слэш на конце значения (самый частый способ его
    // испортить) давал двойной слэш в пути вебхука. Обоснование там.
    const base = publicApiBaseUrl();
    return `${base}/conversations/webhook/transcription?conversationId=${conversationId}`;
  }
}
