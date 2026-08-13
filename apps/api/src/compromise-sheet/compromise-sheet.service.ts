// Пункт 70: CompromiseSheetService (§3.41 ТЗ) — "Компромиссный лист
// при спарринге", пункт 59 общего списка v4-роадмапа. По прямому
// запросу, найдено полным аудитом v4-роадмапа.
//
// СИНТЕЗ ИЗ УЖЕ СУЩЕСТВУЮЩИХ ДАННЫХ — "на основе текущей базы
// аргументации, разбора совпадения/конфликта целей (3.18) и
// аргументов для примирения (3.14)" (buкально ТЗ): читает уже
// существующие Argument (project-level PRO/CON), MotiveHypothesis
// (Пункт 59 backend) и Argument(stance=RECONCILIATION) (Пункт 49) —
// не переизобретает ни один из этих источников.
//
// "ПОСЛЕ СПАРРИНГА... С УЧЁТОМ ТОГО, ЧТО ВСКРЫЛОСЬ" — для phase=AFTER
// дополнительно читает полную историю SparringMessage той же сессии.
//
// ITEMS СОЗДАЮТ НОВЫЕ Argument(stance=COMPROMISE_PROPOSAL), НЕ
// ССЫЛАЮТСЯ НА PersonFact — та же изоляция слоёв (только Argument-
// уровень покидает приложение), что везде в проекте.
//
// sentToFigurant НЕ МОЖЕТ СТАТЬ TRUE БЕЗ previewedByUser=true —
// "жёсткая проверка на уровне бизнес-логики, не только UI" (buкально
// ТЗ) — проверяется здесь, не полагается на дисциплину клиента.
//
// ОЗВУЧКА — переиспользует уже готовый TextToSpeechService (Пункт 63),
// не новую TTS-интеграцию. Собственный голос пользователя (audioSource
// =USER_VOICE) честно НЕ реализован в этом проходе — запись+пост-
// обработка (нормализация громкости/пауз/шума) отдельный пункт 60
// общего списка, зафиксирован в /TODO.md, во всём проекте нет аудио-
// инженерной инфраструктуры для этого.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { ArgumentStance, CompromiseSheetAudioSource, CompromiseSheetPhase } from '@prisma/client';

const TASK_TYPE = 'compromise-sheet';

interface RawCompromiseItem {
  text: string;
}

function isValidCompromisePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every((item) => typeof item.text === 'string' && item.text.trim().length > 0);
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Составь СПИСОК конкретных пунктов компромиссного предложения для разговора — то, с чем можно пойти на переговоры, учитывая уже собранные аргументы, разбор целей сторон и (если есть) аргументы для примирения. Каждый пункт — короткое, конкретное, реалистичное предложение (не абстрактный совет вроде "будьте гибче"), сформулированное так, что его можно прямо произнести оппоненту. Если дан фрагмент диалога тренировочного спарринга — учти, какие возражения там прозвучали, скорректируй пункты с учётом этого, не игнорируй. Ответь СТРОГО валидным JSON-массивом объектов вида {"text": string}. Если пунктов для предложения не нашлось — верни пустой массив. Без пояснений вне JSON.';

@Injectable()
export class CompromiseSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly tts: TextToSpeechService,
  ) {}

  async generate(userId: string, sparringSessionId: string, phase: CompromiseSheetPhase, engineId?: string) {
    const session = await this.findOwnedSession(userId, sparringSessionId);

    const [projectArguments, reconciliationArguments, motiveHypotheses] = await Promise.all([
      this.prisma.argument.findMany({
        where: { projectId: session.projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
      }),
      this.prisma.argument.findMany({ where: { projectId: session.projectId, stance: ArgumentStance.RECONCILIATION } }),
      session.targetPersonId
        ? this.prisma.motiveHypothesis.findMany({ where: { projectId: session.projectId, personId: session.targetPersonId } })
        : Promise.resolve([]),
    ]);

    let dialogueText = '';
    if (phase === CompromiseSheetPhase.AFTER) {
      const messages = await this.prisma.sparringMessage.findMany({
        where: { sessionId: sparringSessionId },
        orderBy: { createdAt: 'asc' },
      });
      if (messages.length <= 1) {
        throw new BadRequestException('Для листа "после" нужен хотя бы один обмен репликами в спарринге — тренировка ещё не началась');
      }
      dialogueText = messages
        .map((m: { role: string; text: string }) => `${m.role === 'OPPONENT' ? 'Оппонент' : 'Пользователь'}: ${m.text}`)
        .join('\n');
    }

    const argumentsText = projectArguments.map((a: { stance: string; text: string }) => `(${a.stance}) ${a.text}`).join('\n');
    const reconciliationText = reconciliationArguments.map((a: { text: string }) => a.text).join('\n');
    const motiveText = motiveHypotheses
      .map((m: { explanation: string; alignmentWithUserGoal: string | null }) => `${m.explanation}${m.alignmentWithUserGoal ? ` (${m.alignmentWithUserGoal})` : ''}`)
      .join('\n');

    const userPrompt = [
      `Ситуация: ${session.project.question}`,
      argumentsText ? `Уже собранные аргументы:\n${argumentsText}` : '',
      motiveText ? `Разбор вероятных мотивов и целей оппонента:\n${motiveText}` : '',
      reconciliationText ? `Аргументы для примирения:\n${reconciliationText}` : '',
      phase === CompromiseSheetPhase.AFTER ? `Фрагмент диалога тренировочного спарринга:\n${dialogueText}` : '',
      phase === CompromiseSheetPhase.BEFORE
        ? 'Составь черновой компромиссный лист — с чем идти на тренировку.'
        : 'Составь ОБНОВЛЁННЫЙ компромиссный лист с учётом того, что вскрылось во время тренировки.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: session.projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidCompromisePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить компромиссный лист — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawItems: RawCompromiseItem[] = JSON.parse(result.text);

    const sheet = await this.prisma.compromiseSheet.create({
      data: { sparringSessionId, phase, generatedByInferenceId: result.aiInferenceId },
    });

    for (const item of rawItems) {
      const argument = await this.prisma.argument.create({
        data: { projectId: session.projectId, text: item.text, stance: ArgumentStance.COMPROMISE_PROPOSAL },
      });
      await this.prisma.compromiseSheetItem.create({ data: { compromiseSheetId: sheet.id, argumentId: argument.id } });
    }

    return this.getSheet(userId, sheet.id);
  }

  async getSheet(userId: string, sheetId: string) {
    await this.assertOwnedSheet(userId, sheetId);
    return this.prisma.compromiseSheet.findUniqueOrThrow({
      where: { id: sheetId },
      include: { items: { include: { argument: true } } },
    });
  }

  async listForSession(userId: string, sparringSessionId: string) {
    await this.findOwnedSession(userId, sparringSessionId);
    return this.prisma.compromiseSheet.findMany({
      where: { sparringSessionId },
      include: { items: { include: { argument: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** "Тот же паттерн, что в 3.24/3.26" — переиспользует уже готовый
   * TextToSpeechService, не новую TTS-интеграцию. */
  async generateVoiceOver(userId: string, sheetId: string, voiceId?: string) {
    const sheet = await this.assertOwnedSheet(userId, sheetId);
    const fullText = sheet.items.map((i: { argument: { text: string } }) => i.argument.text).join('. ');
    if (!fullText.trim()) {
      throw new BadRequestException('Лист пуст — нечего озвучивать');
    }

    const result = await this.tts.synthesize(userId, fullText, voiceId);
    return this.prisma.compromiseSheet.update({
      where: { id: sheetId },
      data: { audioGenerated: true, audioSource: CompromiseSheetAudioSource.ELEVENLABS, audioBase64: result.audioBase64 },
    });
  }

  /** Пункт 71 (§3.41 ТЗ) — "Озвучка собственным голосом через
   * текстовый суфлёр". Сама обработка (нормализация/паузы/шум)
   * выполняется ЦЕЛИКОМ на клиенте (apps/tma/src/lib/audio-post-
   * process.ts) — этот метод только персистит уже готовый результат
   * + флаги того, какая обработка была применена, не пересчитывает и
   * не может пересчитать (исходной необработанной записи у backend
   * никогда не было). */
  async submitUserVoiceRecording(
    userId: string,
    sheetId: string,
    audioBase64: string,
    postProcessing: { normalizeVolume: boolean; removePauses: boolean; removeNoise: boolean },
  ) {
    await this.assertOwnedSheet(userId, sheetId);
    if (!audioBase64.trim()) {
      throw new BadRequestException('audioBase64 не может быть пустым');
    }
    return this.prisma.compromiseSheet.update({
      where: { id: sheetId },
      data: {
        audioGenerated: true,
        audioSource: CompromiseSheetAudioSource.USER_VOICE,
        audioBase64,
        postProcessingNormalizeVolume: postProcessing.normalizeVolume,
        postProcessingRemovePauses: postProcessing.removePauses,
        postProcessingRemoveNoise: postProcessing.removeNoise,
      },
    });
  }

  /** "Пользователь просмотрел перед отправкой" — предпосылка для
   * sentToFigurant, см. markSentToFigurant(). */
  async markPreviewed(userId: string, sheetId: string) {
    await this.assertOwnedSheet(userId, sheetId);
    return this.prisma.compromiseSheet.update({ where: { id: sheetId }, data: { previewedByUser: true } });
  }

  /** "sentToFigurant не может стать true, пока previewedByUser не
   * true — жёсткая проверка на уровне бизнес-логики, не только UI"
   * (buкально ТЗ). TMA обязана предварительно провести лист через
   * Safe Share pipeline (Пункт 12) — это ОТДЕЛЬНЫЙ, дополняющий
   * механизм (PII-сканирование), не заменяет эту проверку и не
   * заменяется ею. */
  async markSentToFigurant(userId: string, sheetId: string) {
    const sheet = await this.assertOwnedSheet(userId, sheetId);
    if (!sheet.previewedByUser) {
      throw new ForbiddenException('Лист нужно сначала просмотреть (markPreviewed), прежде чем отмечать его отправленным');
    }
    return this.prisma.compromiseSheet.update({ where: { id: sheetId }, data: { sentToFigurant: true } });
  }

  private async assertOwnedSheet(userId: string, sheetId: string) {
    const sheet = await this.prisma.compromiseSheet.findUnique({
      where: { id: sheetId },
      include: { items: { include: { argument: true } }, sparringSession: { include: { project: true } } },
    });
    if (!sheet || sheet.sparringSession.project.ownerId !== userId) {
      throw new NotFoundException(`CompromiseSheet ${sheetId} not found`);
    }
    return sheet;
  }

  private async findOwnedSession(userId: string, sparringSessionId: string) {
    const session = await this.prisma.sparringSession.findUnique({
      where: { id: sparringSessionId },
      include: { project: true },
    });
    if (!session || session.project.ownerId !== userId) {
      throw new NotFoundException(`SparringSession ${sparringSessionId} not found`);
    }
    return session;
  }
}
