// Пункт 84: LiveArgumentTrackingService (§3.33 ТЗ, "список аргументов
// на экране — динамический трекинг") — вторая половина прохода 2
// "экрана сопровождения". По прямому запросу.
//
// ПЕРСИСТЕНТНАЯ ЗАПИСЬ НА АРГУМЕНТ, НЕ ПЕРЕСЧИТЫВАЕТСЯ С НУЛЯ КАЖДЫЙ
// ЦИКЛ — "уже достаточно упомянут" не должно забываться, стоит
// транскрипту выйти за окно ~10 минут на клиенте (та же граница
// клиентского окна, что уже применяется в LiveHintsService/
// LiveManipulationService). checkStatus() читает текущий
// LiveArgumentTrackingStatus каждого аргумента и передаёт его AI как
// контекст — модель решает, повышать ли статус, не начинает с нуля.
//
// СТАТУС МОЖЕТ ТОЛЬКО ПОВЫШАТЬСЯ ПО ЗНАЧИМОСТИ В РАМКАХ ОДНОЙ СЕССИИ
// (NOT_MENTIONED → NEEDS_REPEAT → SUFFICIENTLY_MENTIONED →
// GENUINELY_ACCEPTED), НЕ ПОНИЖАЕТСЯ — проверяется в service-слое, не
// полагается только на инструкцию AI не понижать статус.
//
// GENUINELY_ACCEPTED ТРЕБУЕТ СВЕРКИ С LiveManipulationFlag (Пункт 83)
// — "если согласие похоже на манипулятивный манёвр, зелёным не
// подсвечивается" (buкально ТЗ). Проверяется явно в коде ПОСЛЕ ответа
// AI, не полагается только на то, что AI сам учтёт это в промпте —
// если AI всё же предложил GENUINELY_ACCEPTED, а недавний
// LiveManipulationFlag существует, статус честно понижается до
// SUFFICIENTLY_MENTIONED вместо принятия ответа AI как есть.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, ArgumentTrackingState, LiveArgumentTrackingStatus } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'live-argument-tracking';

// Порядок значимости — используется для проверки "статус может только повышаться".
const STATE_RANK: Record<ArgumentTrackingState, number> = {
  NOT_MENTIONED: 0,
  NEEDS_REPEAT: 1,
  SUFFICIENTLY_MENTIONED: 2,
  GENUINELY_ACCEPTED: 3,
};

// "Согласие похоже на манипулятивный манёвр" считается недавним, если
// уловка была зафиксирована в последние N секунд — та же ширина, что
// цикл проверки трекинга, не произвольное число.
const MANIPULATION_LOOKBACK_MS = 30_000;

interface RawArgumentUpdate {
  argumentId: string;
  status: 'NOT_MENTIONED' | 'NEEDS_REPEAT' | 'SUFFICIENTLY_MENTIONED' | 'GENUINELY_ACCEPTED';
}

function isValidTrackingPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.argumentId === 'string' &&
        ['NOT_MENTIONED', 'NEEDS_REPEAT', 'SUFFICIENTLY_MENTIONED', 'GENUINELY_ACCEPTED'].includes(item.status),
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан ПОСЛЕДНИЙ фрагмент транскрипта живого разговора и список ключевых аргументов пользователя с их ТЕКУЩИМ статусом отслеживания. Для КАЖДОГО аргумента из списка реши, изменился ли его статус на основе этого фрагмента: NOT_MENTIONED — ещё не упомянут; NEEDS_REPEAT — упомянут, но стоит повторить (например, собеседник не отреагировал или перебил); SUFFICIENTLY_MENTIONED — уже достаточно раскрыт, повторять не нужно; GENUINELY_ACCEPTED — собеседник ЯВНО и искренне согласился именно с этим аргументом (не просто "угу", а содержательное согласие). НЕ ПОНИЖАЙ статус ниже текущего — если аргумент уже SUFFICIENTLY_MENTIONED, а в этом фрагменте он не упоминается, оставь как есть, не откатывай к NOT_MENTIONED. Если статус аргумента не меняется — можешь не включать его в ответ вообще, не обязательно возвращать все аргументы каждый раз. Ответь СТРОГО валидным JSON-массивом объектов вида {"argumentId": string, "status": "NOT_MENTIONED"|"NEEDS_REPEAT"|"SUFFICIENTLY_MENTIONED"|"GENUINELY_ACCEPTED"}. Если ничего не изменилось — верни пустой массив [].';

@Injectable()
export class LiveArgumentTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** Инициализация — из базы аргументов проекта создаёт (или
   * возвращает уже существующие) записи трекинга со стартовым
   * статусом NOT_MENTIONED, если их ещё нет. */
  async initialize(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const projectArguments = await this.prisma.argument.findMany({
      where: { projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
    });

    for (const arg of projectArguments) {
      const existing = await this.prisma.liveArgumentTrackingStatus.findUnique({ where: { argumentId: arg.id } });
      if (!existing) {
        await this.prisma.liveArgumentTrackingStatus.create({
          data: { projectId, argumentId: arg.id, status: ArgumentTrackingState.NOT_MENTIONED },
        });
      }
    }

    return this.list(userId, projectId);
  }

  async checkStatus(userId: string, projectId: string, transcriptWindow: string, engineId?: string) {
    if (!transcriptWindow.trim()) {
      throw new BadRequestException('transcriptWindow не может быть пустым');
    }
    await assertProjectOwnership(this.prisma, userId, projectId);

    const trackedStatuses = await this.prisma.liveArgumentTrackingStatus.findMany({
      where: { projectId },
      include: { argument: true },
    });
    if (trackedStatuses.length === 0) {
      throw new BadRequestException('Список отслеживаемых аргументов пуст — вызовите initialize() перед checkStatus()');
    }

    const argumentsText = trackedStatuses
      .map((s: { argumentId: string; status: string; argument: { text: string } }) => `[${s.argumentId}] (текущий статус: ${s.status}) ${s.argument.text}`)
      .join('\n');

    const userPrompt = `Фрагмент транскрипта:\n${transcriptWindow}\n\nОтслеживаемые аргументы:\n${argumentsText}`;

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
        maxTokens: 800,
        validateOutput: isValidTrackingPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось проверить статусы — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawUpdates: RawArgumentUpdate[] = JSON.parse(result.text);
    const statusMap = new Map<string, ArgumentTrackingState>(
      trackedStatuses.map((s: { argumentId: string; status: ArgumentTrackingState }) => [s.argumentId, s.status]),
    );

    // "Недавняя уловка" проверяется один раз на весь цикл, не на каждый аргумент отдельно.
    const recentManipulation = await this.prisma.liveManipulationFlag.findFirst({
      where: { projectId, createdAt: { gte: new Date(Date.now() - MANIPULATION_LOOKBACK_MS) } },
    });

    const updated: LiveArgumentTrackingStatus[] = [];
    for (const update of rawUpdates) {
      const currentStatus = statusMap.get(update.argumentId);
      if (currentStatus === undefined) continue; // AI указал argumentId, которого нет в отслеживаемых — честно игнорируем, не создаём новую запись

      let nextStatus = update.status as ArgumentTrackingState;

      // "Статус может только повышаться" — проверяется здесь, не полагается на инструкцию промпта.
      if (STATE_RANK[nextStatus] < STATE_RANK[currentStatus]) {
        continue; // AI попытался понизить статус — честно игнорируем этот конкретный update, не откатываем
      }

      // "Если согласие похоже на манипулятивный манёвр, зелёным не подсвечивается" — проверяется здесь явно, не только в промпте.
      if (nextStatus === ArgumentTrackingState.GENUINELY_ACCEPTED && recentManipulation) {
        nextStatus = ArgumentTrackingState.SUFFICIENTLY_MENTIONED;
      }

      if (nextStatus === currentStatus) continue; // реального изменения нет — не трогаем lastCheckedAt зря

      const record = await this.prisma.liveArgumentTrackingStatus.update({
        where: { argumentId: update.argumentId },
        data: { status: nextStatus, lastCheckedAt: new Date() },
      });
      updated.push(record);
    }

    return updated;
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.liveArgumentTrackingStatus.findMany({
      where: { projectId },
      include: { argument: true },
      orderBy: { lastCheckedAt: 'desc' },
    });
  }
}
