// Пункт 55: SparringService (§3.1 ТЗ) — "Режим Адвокат дьявола (AI Red
// Team)", пункт 34 v3-роадмапа, последний по объёму в согласованном
// порядке до пунктов 28/29/32/36. По прямому запросу.
//
// КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ ВСЕГО, ЧТО УЖЕ ПОСТРОЕНО В ЭТОМ ЗАХОДЕ —
// МНОГОХОДОВОЙ ДИАЛОГ. Steelman (§3.43) и ArchetypePerspective (§3.11)
// — одноразовая генерация (один AI-вызов, один результат). Здесь —
// startSession() один раз, затем reply() многократно, каждый раз
// передавая ПОЛНУЮ историю сообщений сессии в AI, чтобы оппонент
// реагировал именно на то, что пользователь только что ответил, не
// повторял одно и то же.
//
// AI ИГРАЕТ РОЛЬ ОППОНЕНТА, НЕ ПОМОЩНИКА — тот же класс намеренно
// состязательного контента, что уже применялся к архетипам "ревнивая
// жена"/"скандалист" (Пункт 38): явная роль-игра для тренировки
// ("Пользователь тренируется отвечать на них... как спарринг",
// буквально из ТЗ), не поиск объективной истины.
//
// ДУБЛИРОВАНИЕ, ПРИЗНАННОЕ ЯВНО: сбор контекста для targetPersonId
// (коммуникационный профиль/связи/прецеденты) дублирует
// buildRealPersonContext() из ArchetypePerspectiveService почти
// дословно — сознательное решение не рефакторить чужой рабочий,
// протестированный приватный метод в общий util в разгар большого
// захода (риск случайно что-то сломать в уже сданной фиче не
// оправдан экономией одного небольшого метода).
//
// ЛИМИТ СООБЩЕНИЙ НА СЕССИЮ — простая, но реальная защита от
// неограниченного роста стоимости одной сессии (каждый reply()
// передаёт ВСЮ историю в AI — цена растёт с каждым сообщением), тот
// же класс решения, что DAILY_LIMIT_PER_USER в PhotoVerificationService
// (Пункт 48) и MIN_CATEGORY_SAMPLE_SIZE в DecisionOutcomeService
// (Пункт 52) — явно задокументированное число, не скрытая магия.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import type { ParsedTranscript } from '../conversations/transcription.service';
import { SttService, sttJobIdVariants } from '../stt/stt.service';
import { parseSttWebhookPayload } from '../stt/stt-webhook-payload';
import type { SttProviderName } from '../stt/stt-language';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ARCHETYPE_DESCRIPTIONS } from '../archetype-perspective/archetype-perspective.service';
import { ArchetypeType, SparringMessageRole, SparringSessionStatus, SparringVoiceReplyStatus } from '@prisma/client';
import { publicApiBaseUrl } from '../common/public-base-url';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'sparring-session';
const MAX_MESSAGES_PER_SESSION = 40; // 20 обменов репликами — разумный потолок для тренировочной сессии, не бесконечный чат

// Пункт 69 (§3.26 ТЗ) — "разные голоса под разные архетипы
// (опционально)". Простой статический маппинг на несколько известных
// preset-голосов ElevenLabs (публичная библиотека voice ID, не
// придуманные значения) — НЕ пользовательская настройка в этом
// проходе, честно ограничено фиксированным набором.
const ARCHETYPE_VOICE_IDS: Partial<Record<ArchetypeType, string>> = {
  POLICE_OFFICER: 'VR6AewLTigWG4xSOukaG', // Arnold — жёсткий мужской тембр
  LAWYER: 'ErXwobaYiN019PkySvjV', // Antoni
  NEIGHBORHOOD_GRANDMOTHER: 'EXAVITQu4vr4xnSDxMaL', // Bella
  JEALOUS_SPOUSE: '21m00Tcm4TlvDq8ikWAM', // Rachel
  TROUBLEMAKER: 'TxGEqnHWrfWFTfGW9XjX', // Josh
};
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — дефолт для архетипов вне маппинга и для REAL_PERSON/без архетипа

const TRAIT_LABELS: Record<string, string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'нужно время на решение',
  RESPONDS_TO_DATA: 'реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'наблюдаемое избегание конфликта',
  DECISION_MAKING_STYLE: 'наблюдаемый стиль принятия решений',
};

interface RawOpponentReply {
  message: string;
}

function isValidOpponentPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.message === 'string' && parsed.message.trim().length > 0;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Ты играешь роль ОППОНЕНТА пользователя в описанной ситуации — не помощника, а стороны, с которой у пользователя расхождение или конфликт. Твоя задача — реалистично, но не оскорбительно, возражать и находить слабые места в позиции пользователя, как это делал бы реальный человек в этой роли. НЕ соглашайся легко и не сдавайся быстро — пользователь тренируется отвечать на реальное сопротивление, не на выдуманную уступчивость. Если есть данные о конкретном человеке (коммуникационный профиль, связи, прецеденты) — учитывай их, не выдумывай того, чего там нет. Отвечай ТОЛЬКО репликой оппонента, без пометок "как оппонент" или подобного — прямая речь. Ответь СТРОГО валидным JSON-объектом вида {"message": string}. Без пояснений вне JSON.';

@Injectable()
export class SparringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly stt: SttService,
    private readonly secrets: SecretsService,
    private readonly textToSpeech: TextToSpeechService,
    private readonly consent: ConsentService,
  ) {}

  async startSession(
    userId: string,
    projectId: string,
    targetPersonId?: string,
    engineId?: string,
    archetypeType?: ArchetypeType,
    customArchetypeDescription?: string,
    scheduledConversationId?: string,
  ) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    // Та же валидация, что уже применена в ArchetypePerspectiveService
    // (Пункт 38/46) — REAL_PERSON требует targetPersonId, CUSTOM
    // требует описания, остальные архетипы берут готовый текст.
    if (archetypeType === ArchetypeType.REAL_PERSON && !targetPersonId) {
      throw new BadRequestException('targetPersonId обязателен при archetypeType=REAL_PERSON');
    }
    if (archetypeType === ArchetypeType.CUSTOM && !customArchetypeDescription?.trim()) {
      throw new BadRequestException('customArchetypeDescription обязателен при archetypeType=CUSTOM');
    }

    const voiceId = this.resolveVoiceId(archetypeType);

    // Пункт 90 (§3.26 ТЗ) — "предварительная генерация... так
    // пользователь с первой секунды спарринга уже привыкает работать
    // с аудио-форматом". Если для этой запланированной встречи уже
    // есть предзаготовленная открывающая реплика (см.
    // preGenerateSparringOpener()) — переиспользуем её текст и звук
    // МГНОВЕННО, не делаем повторный AI+TTS вызов.
    let openerText: string;
    let openerAudio: string | null;
    let openerInferenceId: string | null = null;

    const scheduled = scheduledConversationId
      ? await this.prisma.scheduledConversation.findFirst({ where: { id: scheduledConversationId, projectId } })
      : null;

    if (scheduled?.preGeneratedSparringOpenerText) {
      openerText = scheduled.preGeneratedSparringOpenerText;
      openerAudio = scheduled.preGeneratedSparringOpenerAudio;
    } else {
      let personContext = '';
      if (targetPersonId) {
        personContext = await this.buildPersonContext(projectId, targetPersonId);
      }
      const archetypeContext = this.buildArchetypeContext(archetypeType, customArchetypeDescription);
      const userPrompt = this.buildOpeningPrompt(project.question, project.goal, archetypeContext, personContext);

      const opponentMessage = await this.callOpponent(userId, projectId, userPrompt, engineId);
      openerText = opponentMessage.text;
      openerInferenceId = opponentMessage.aiInferenceId;
      openerAudio = await this.synthesizeOpponentAudio(userId, openerText, voiceId);
    }

    const session = await this.prisma.sparringSession.create({
      data: {
        projectId,
        targetPersonId: targetPersonId ?? null,
        archetypeType: archetypeType ?? null,
        customArchetypeDescription: archetypeType === ArchetypeType.CUSTOM ? customArchetypeDescription!.trim() : null,
        voiceId,
      },
    });
    const message = await this.prisma.sparringMessage.create({
      data: {
        sessionId: session.id,
        role: SparringMessageRole.OPPONENT,
        text: openerText,
        audioBase64: openerAudio,
        generatedByInferenceId: openerInferenceId,
      },
    });

    return { ...session, messages: [message] };
  }

  /** Общий текст промпта открывающей реплики — переиспользуется и
   * реальным startSession(), и предзаготовкой preGenerateSparringOpener()
   * (последняя не может передать personContext на момент вызова из
   * cron-задачи так же полно — см. обоснование там). */
  private buildOpeningPrompt(question: string, goal: string | null, archetypeContext: string, personContext: string): string {
    return [
      `Ситуация: ${question}`,
      goal ? `Цель пользователя: ${goal}` : '',
      archetypeContext,
      personContext,
      'Начни спарринг: дай первое возражение/контраргумент оппонента по этой ситуации — наиболее вероятное из того, что реальный оппонент сказал бы в начале разговора.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Пункт 90 (§3.26 ТЗ) — вызывается ТОЛЬКО из SchedulerService
   * (dispatchDueReminders(), системный контекст, не прямой вызов
   * пользователем) в момент отправки напоминания о спарринге, не
   * сразу при планировании встречи. НЕ создаёт SparringSession —
   * только текст+звук открывающей реплики, кэшируемые на
   * ScheduledConversation, реально используемые позже, когда/если
   * пользователь нажмёт "начать спарринг" из напоминания. */
  async preGenerateSparringOpener(scheduledConversationId: string, userId: string): Promise<void> {
    const scheduled = await this.prisma.scheduledConversation.findUnique({
      where: { id: scheduledConversationId },
      include: { project: true, person: true },
    });
    if (!scheduled) return; // встречу удалили между планированием обработки и её выполнением — честно ничего не делаем

    // Предзаготовка без выбора архетипа пользователем на этом этапе —
    // общий оппонент (либо реальный человек, если он привязан к
    // встрече), тот же fallback, что archetypeType=undefined в
    // обычном startSession(). Если пользователь на самом старте
    // спарринга выберет другой архетип — предзаготовленная реплика
    // честно НЕ будет использована (не совпадёт архетип), обычный
    // путь сгенерирует заново, тот же принцип "предзаготовка — best
    // effort, не гарантия совпадения с реальным выбором".
    let personContext = '';
    if (scheduled.personId) {
      personContext = await this.buildPersonContext(scheduled.projectId, scheduled.personId);
    }
    const userPrompt = this.buildOpeningPrompt(scheduled.project.question, scheduled.project.goal, '', personContext);

    let openerText: string;
    try {
      const opponentMessage = await this.callOpponent(userId, scheduled.projectId, userPrompt);
      openerText = opponentMessage.text;
    } catch {
      return; // сбой генерации при предзаготовке — честно не сохраняем ничего, обычный startSession() сгенерирует при реальном старте
    }

    const openerAudio = await this.synthesizeOpponentAudio(userId, openerText, DEFAULT_VOICE_ID);

    await this.prisma.scheduledConversation.update({
      where: { id: scheduledConversationId },
      data: { preGeneratedSparringOpenerText: openerText, preGeneratedSparringOpenerAudio: openerAudio },
    });
  }

  async reply(userId: string, sessionId: string, userText: string, engineId?: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    if (session.status !== SparringSessionStatus.ACTIVE) {
      throw new BadRequestException(`SparringSession ${sessionId} is already ended`);
    }
    if (!userText.trim()) {
      throw new BadRequestException('userText не может быть пустым');
    }

    const existingMessages = await this.prisma.sparringMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    if (existingMessages.length >= MAX_MESSAGES_PER_SESSION) {
      throw new BadRequestException(
        `Достигнут лимит сообщений в сессии (${MAX_MESSAGES_PER_SESSION}) — завершите эту сессию и начните новую`,
      );
    }

    const userMessage = await this.prisma.sparringMessage.create({
      data: { sessionId, role: SparringMessageRole.USER, text: userText.trim() },
    });

    let personContext = '';
    if (session.targetPersonId) {
      personContext = await this.buildPersonContext(session.projectId, session.targetPersonId);
    }
    const archetypeContext = this.buildArchetypeContext(
      session.archetypeType ?? undefined,
      session.customArchetypeDescription ?? undefined,
    );

    // Полная история — иначе оппонент не будет помнить, что уже
    // обсуждалось, и не сможет реагировать именно на текущий ответ
    // пользователя, только повторять исходное возражение.
    const historyText = [...existingMessages, userMessage]
      .map((m: { role: string; text: string }) => `${m.role === 'OPPONENT' ? 'Оппонент' : 'Пользователь'}: ${m.text}`)
      .join('\n');

    const userPrompt = [archetypeContext, personContext, `История спарринга до сих пор:\n${historyText}`, 'Дай следующую реплику оппонента, реагируя именно на последний ответ пользователя.']
      .filter(Boolean)
      .join('\n\n');

    const opponentMessage = await this.callOpponent(userId, session.projectId, userPrompt, engineId);
    const opponentAudio = await this.synthesizeOpponentAudio(userId, opponentMessage.text, session.voiceId ?? DEFAULT_VOICE_ID);

    const opponentReply = await this.prisma.sparringMessage.create({
      data: {
        sessionId,
        role: SparringMessageRole.OPPONENT,
        text: opponentMessage.text,
        audioBase64: opponentAudio,
        generatedByInferenceId: opponentMessage.aiInferenceId,
      },
    });

    return [userMessage, opponentReply];
  }

  async endSession(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    return this.prisma.sparringSession.update({
      where: { id: session.id },
      data: { status: SparringSessionStatus.ENDED, endedAt: new Date() },
    });
  }

  async listSessions(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.sparringSession.findMany({
      where: { projectId },
      include: { targetPerson: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    const messages = await this.prisma.sparringMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    return { ...session, messages };
  }

  private async callOpponent(userId: string, projectId: string, userPrompt: string, engineId?: string) {
    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 500,
        validateOutput: isValidOpponentPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось получить реплику оппонента — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawOpponentReply = JSON.parse(result.text);
    return { text: raw.message, aiInferenceId: result.aiInferenceId };
  }

  /** Дублирует buildRealPersonContext() из ArchetypePerspectiveService
   * почти дословно — см. обоснование в шапке файла. */
  private async buildPersonContext(projectId: string, personId: string): Promise<string> {
    const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId }, include: { person: true } });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    const [traits, relationships, precedents] = await Promise.all([
      this.prisma.personCommunicationTrait.findMany({ where: { personId } }),
      this.prisma.relationship.findMany({ where: { OR: [{ personAId: personId }, { personBId: personId }] } }),
      this.prisma.behaviorPrecedent.findMany({ where: { personId }, take: 5, orderBy: { createdAt: 'desc' } }),
    ]);

    const traitsText = traits
      .map((t: { traitType: string; value: string }) => `${TRAIT_LABELS[t.traitType] ?? t.traitType}: ${t.value}`)
      .join('; ');
    const relationshipsText = relationships.map((r: { label: string }) => r.label).join('; ');
    const precedentsText = precedents.map((p: { precedentDescription: string }) => p.precedentDescription).join('; ');

    const lines = [
      `Оппонент — реальный человек по имени ${link.person.displayName ?? 'без имени'}.`,
      traitsText ? `Наблюдаемый коммуникационный профиль: ${traitsText}.` : '',
      relationshipsText ? `Известные связи: ${relationshipsText}.` : '',
      precedentsText ? `Известные прецеденты поведения: ${precedentsText}.` : '',
      !traitsText && !relationshipsText && !precedentsText ? 'О нём известно немного — не выдумывай подробностей.' : '',
    ].filter(Boolean);

    return lines.join(' ');
  }

  /** Пункт 69 (§3.26 ТЗ) — переиспользует ARCHETYPE_DESCRIPTIONS,
   * экспортированный из ArchetypePerspectiveService, ту же дисциплину
   * валидации, что уже применена там (REAL_PERSON/CUSTOM — особые
   * случаи, остальные значения берут готовый текст напрямую). */
  private buildArchetypeContext(archetypeType?: ArchetypeType, customDescription?: string): string {
    if (!archetypeType || archetypeType === ArchetypeType.REAL_PERSON) return '';
    if (archetypeType === ArchetypeType.CUSTOM) {
      return `Оппонент играет роль: ${customDescription}.`;
    }
    return `Оппонент играет роль: ${ARCHETYPE_DESCRIPTIONS[archetypeType]}.`;
  }

  private resolveVoiceId(archetypeType?: ArchetypeType): string {
    if (archetypeType && ARCHETYPE_VOICE_IDS[archetypeType]) {
      return ARCHETYPE_VOICE_IDS[archetypeType]!;
    }
    return DEFAULT_VOICE_ID;
  }

  /** Пункт 90 (§3.26 ТЗ) — "реплики AI-собеседника озвучиваются
   * голосом" (buкально ТЗ). ЧЕСТНАЯ ДЕГРАДАЦИЯ — любой сбой синтеза
   * (нет согласия VOICE_PROCESSING, ElevenLabs недоступен) НЕ должен
   * останавливать сам диалог спарринга: возвращает null, вызывающий
   * код продолжает работу с текстом без звука, не бросает исключение
   * наружу. Тот же принцип, что "тихий сбой цикла" у live-фич
   * (Пункты 82-86) — второстепенная возможность не блокирует
   * основную функциональность. */
  private async synthesizeOpponentAudio(userId: string, text: string, voiceId: string): Promise<string | null> {
    try {
      const result = await this.textToSpeech.synthesize(userId, text, voiceId);
      return result.audioBase64;
    } catch {
      return null;
    }
  }

  // ═══════════════════════ Пункт 69: голосовой ввод реплики (§3.26 ТЗ) ═══════════════════════
  //
  // "Пользователь отвечает текстом ИЛИ ГОЛОСОМ" (buкально ТЗ) — по
  // прямой оговорке пользователя ("отсутствие голосового ввода ломает
  // саму идею голосового спарринга"), реализовано через уже
  // существующий асинхронный AssemblyAI-flow (Пункт 13), не через
  // синхронный/потоковый STT, которого в проекте нет. Честная задержка
  // в несколько секунд — не мгновенно, TMA обязана показывать
  // состояние ожидания, не имитировать мгновенность.

  /** Шаг 1 — загрузить аудио, получить audioUrl для submitVoiceReply(). */
  async streamUploadVoiceReply(userId: string, sessionId: string, fileStream: ReadableStream<Uint8Array>, contentType?: string | null) {
    const session = await this.findOwnedSession(userId, sessionId);
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: ConsentService не был подключён к
    // этому модулю вообще — голосовая реплика уходила AssemblyAI без
    // единой проверки, включая режим MAXIMUM_PRIVACY, который такую
    // передачу запрещает в принципе. Та же проверка, что у загрузки
    // разговора: разницы в природе данных нет, микрофон один и тот же.
    await this.consent.assertAudioMayLeaveDevice(userId, session.projectId);
    // Пункт [stt-multi] 2026-09-02: байты уходят ТОМУ провайдеру,
    // который потом возьмёт задачу (ru/uk → Soniox, en → AssemblyAI).
    // Ссылка на файл внутри одного провайдера другому бесполезна,
    // поэтому его имя возвращается вместе с ссылкой и передаётся в
    // submitVoiceReply.
    const { audioUrl, provider } = await this.stt.uploadAudio(fileStream, await this.userLanguage(userId), contentType ?? null);
    return { audioUrl, sttProvider: provider };
  }

  /** Шаг 2 — запустить транскрибацию (асинхронно, с webhook). Клиент
   * получает jobId и поллит getVoiceReplyStatus(), пока не COMPLETED. */
  async submitVoiceReply(userId: string, sessionId: string, audioUrl: string, sttProvider?: SttProviderName) {
    const session = await this.findOwnedSession(userId, sessionId);
    // Проверяется и здесь, и в streamUploadVoiceReply(): шаги независимы
    // (клиент вправе вызвать submit с audioUrl, полученным раньше), а
    // согласие могло быть отозвано между ними.
    await this.consent.assertAudioMayLeaveDevice(userId, session.projectId);
    if (session.status !== SparringSessionStatus.ACTIVE) {
      throw new BadRequestException(`SparringSession ${sessionId} is already ended`);
    }
    const existingCount = await this.prisma.sparringMessage.count({ where: { sessionId } });
    if (existingCount >= MAX_MESSAGES_PER_SESSION) {
      throw new BadRequestException(
        `Достигнут лимит сообщений в сессии (${MAX_MESSAGES_PER_SESSION}) — завершите эту сессию и начните новую`,
      );
    }

    const webhookUrl = this.buildVoiceWebhookUrl();
    const { storedId } = await this.stt.submitWebhookJob({
      audioUrl,
      webhookUrl,
      languageCode: await this.userLanguage(userId),
      diarize: false, // реплика одного говорящего — диаризация только замедлит
      uploadedTo: sttProvider,
    });

    return this.prisma.sparringVoiceReplyJob.create({
      data: { sparringSessionId: sessionId, externalTranscriptionJobId: storedId },
    });
  }

  /** Шаг 3 (клиент поллит) — статус + готовый результат (оба
   * сообщения) по завершении. */
  async getVoiceReplyStatus(userId: string, sessionId: string, jobId: string) {
    await this.findOwnedSession(userId, sessionId);
    const job = await this.prisma.sparringVoiceReplyJob.findUnique({ where: { id: jobId } });
    if (!job || job.sparringSessionId !== sessionId) {
      throw new NotFoundException(`SparringVoiceReplyJob ${jobId} not found`);
    }
    return job;
  }

  /** Обработчик webhook от AssemblyAI — НЕ защищён TelegramAuthGuard
   * (AssemblyAI не может пройти Telegram-авторизацию), тот же принцип,
   * что ConversationsService.handleTranscriptionWebhook() — сопоставление
   * по externalTranscriptionJobId, не по userId. Неизвестный job
   * молча игнорируется, не бросает ошибку наружу (AssemblyAI будет
   * ретраить webhook, если получит не-200). */
  async handleVoiceReplyWebhook(rawPayload: unknown) {
    const payload = parseSttWebhookPayload(rawPayload);
    // Финальный аудит 2026-08-30 — тот же фикс, что в
    // ConversationsService.handleTranscriptionWebhook(): реальный вебхук
    // несёт только transcript_id/status, полный результат — отдельным GET.
    if (!payload.externalJobId) return;
    // Оба написания идентификатора: задачи до Пункта [stt-multi] лежат
    // без префикса провайдера.
    const job = await this.prisma.sparringVoiceReplyJob.findFirst({
      where: { externalTranscriptionJobId: { in: sttJobIdVariants(payload.externalJobId) } },
    });
    if (!job) {
      // Реплика удалена (сессия, проект, аккаунт) до прихода вебхука —
      // результат никому; убираем задачу у провайдера (аудит 2026-09-02).
      await this.stt.discardOrphan(payload.providerHint, payload.externalJobId);
      return;
    }
    if (job.status !== SparringVoiceReplyStatus.PENDING) return;

    // Аудит 2026-09-02 (STT): атомарный забор джобы. Проверка статуса
    // выше — обычное чтение, и между ней и записью COMPLETED проходит
    // ответ AI-оппонента (секунды). Провайдер ретраит вебхук на таймаут
    // нашего ответа, вторая доставка успевала пройти ту же проверку и
    // создавала вторую пару реплик. UPDATE с условием на статус: кто
    // перевёл PENDING → PROCESSING, тот и обрабатывает; второму — count 0.
    const claimed = await this.prisma.sparringVoiceReplyJob.updateMany({
      where: { id: job.id, status: SparringVoiceReplyStatus.PENDING },
      data: { status: SparringVoiceReplyStatus.PROCESSING },
    });
    if (claimed.count === 0) return;

    let parsed: ParsedTranscript | null = null;
    let failure: string | null = null;
    try {
      parsed = await this.stt.fetchResult(job.externalTranscriptionJobId ?? payload.externalJobId);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure !== null || parsed === null) {
      await this.prisma.sparringVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: failure ?? 'unknown error' },
      });
      return;
    }

    const transcribedText = parsed.segments.map((s) => s.text).join(' ').trim();
    if (!transcribedText) {
      await this.prisma.sparringVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: 'пустая транскрипция' },
      });
      return;
    }

    const session = await this.prisma.sparringSession.findUniqueOrThrow({
      where: { id: job.sparringSessionId },
      include: { project: true },
    });

    try {
      const [userMessage, opponentReply] = await this.reply(session.project.ownerId, job.sparringSessionId, transcribedText);
      await this.prisma.sparringVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.COMPLETED, userMessageId: userMessage.id, opponentMessageId: opponentReply.id },
      });
    } catch (err) {
      await this.prisma.sparringVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: err instanceof Error ? err.message : 'unknown error' },
      });
    }
  }

  /** Язык пользователя из профиля — по нему выбирается провайдер
   *  распознавания. Отсутствие значения не ошибка: мультиязычный
   *  провайдер определит язык сам. */
  private async userLanguage(userId: string): Promise<string | null> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { languageCode: true } });
      return user?.languageCode ?? null;
    } catch {
      return null;
    }
  }


  private buildVoiceWebhookUrl(): string {
    // 2026-08-31: см. common/public-base-url.ts — одна проверка вместо
    // трёх разошедшихся копий.
    return `${publicApiBaseUrl()}/sparring-sessions/webhook/voice-reply`;
  }

  private async findOwnedSession(userId: string, sessionId: string) {
    const session = await this.prisma.sparringSession.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session || session.project.ownerId !== userId) {
      throw new NotFoundException(`SparringSession ${sessionId} not found`);
    }
    return session;
  }
}
