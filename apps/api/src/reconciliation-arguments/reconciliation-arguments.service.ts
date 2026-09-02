// Пункт 49: ReconciliationArgumentsService (§3.14 ТЗ) — "аргументы для
// примирения из религиозных первоисточников". По прямому запросу,
// после разбора несостыковки в самом ТЗ: пункт 25 v3-роадмапа ссылался
// на онбординг-данные, которые по тому же роадмапу — пункт v4. Разбор
// показал: реальная зависимость (какая традиция) намного уже, чем весь
// пункт 42 (страна/город/вероисповедание/напоминания по расписанию) —
// использует УЖЕ ГОТОВЫЙ, отдельно построенный онбординг (Пункт 49,
// religion field), не ждёт полноценного пункта v4 целиком.
//
// НЕ отдельная модель — "используется... наравне с обычными
// аргументами 'за' и 'против'" (буквально из ТЗ), ArgumentStance
// получил RECONCILIATION, тот же список Argument, что и всё остальное.
//
// ДВОЙНОЕ ТЕГИРОВАНИЕ (§3.10/§3.14 ТЗ) — ссылка на первоисточник
// (книга/глава/стих) 🔵 "публичный факт" хранится ОТДЕЛЬНО от
// применения-к-ситуации 🟡 "догадка ИИ" — разные поля (scriptureReference
// vs text), не смешаны в одном тексте, чтобы разница в достоверности
// была видна структурно, не только по общему тегу происхождения.
//
// АВТОРСКОЕ ПРАВО — "не пересказ и не длинные цитаты... цитата не
// длиннее короткой фразы, основной текст перефразируется" (буквально
// из ТЗ) — совпадает с уже действующим для ВСЕГО проекта глобальным
// ограничением на цитирование (≤15 слов, максимум одна цитата на
// источник), явно продублировано в системном промпте ниже, не
// полагается только на то, что модель "и так это знает".
//
// "ЯВНО НЕ ИСПОЛЬЗУЕТСЯ ДЛЯ МОРАЛЬНОГО СУДА НАД ФИГУРАНТАМИ" —
// буквально из ТЗ — явное ограничение в системном промпте: аргументы
// для СНИЖЕНИЯ конфликта самого пользователя, не для осуждения
// оппонента религиозными терминами.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'reconciliation-arguments';

interface RawReconciliationArgument {
  scriptureReference: string;
  text: string;
}

function isValidReconciliationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.scriptureReference === 'string' &&
        item.scriptureReference.trim().length > 0 &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0,
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты помогаешь пользователю найти аргументы для СНИЖЕНИЯ НАКАЛА КОНФЛИКТА И ПРИМИРЕНИЯ — не для победы в споре. Ищи релевантные места из религиозных первоисточников указанной пользователем традиции на тему прощения, терпения, смирения конфликта, ценности отношений выше правоты в споре. КРИТИЧЕСКИ ВАЖНО ПО АВТОРСКОМУ ПРАВУ: НЕ пересказывай и не приводи длинные цитаты — если приводишь цитату, она должна быть короче 15 слов, максимум одна короткая цитата на аргумент, основной текст — перефразирование своими словами, не близкий пересказ формулировок первоисточника. Для каждого найденного аргумента дай: scriptureReference — точная ссылка на место (книга, глава, стих), text — кратко своими словами суть ЭТОГО места + пояснение, как это применимо к текущей ситуации пользователя. НИКОГДА не используй это для морального суда над оппонентом пользователя — только как источник аргументов и рамок для снижения конфликта самого пользователя. Ответь СТРОГО валидным JSON-массивом объектов вида {"scriptureReference": string, "text": string}. Если подходящих мест не нашлось — верни пустой массив. Без пояснений вне JSON.';

@Injectable()
export class ReconciliationArgumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(userId: string, projectId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { religion: true } });
    if (!user.religion) {
      throw new BadRequestException(
        'Для аргументов примирения нужно сначала указать вероисповедание в настройках онбординга ("не указывать" оставит эту функцию недоступной)',
      );
    }

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Цель пользователя: ${project.goal}` : '',
      `Традиция пользователя: ${user.religion}`,
      'Найди 2-3 релевантных места из первоисточников этой традиции на тему прощения/терпения/примирения, применимых к описанной ситуации.',
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
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidReconciliationPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось найти аргументы для примирения — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawArguments: RawReconciliationArgument[] = JSON.parse(result.text);
    return this.prisma.$transaction(
      rawArguments.map((arg) =>
        this.prisma.argument.create({
          data: {
            projectId,
            stance: ArgumentStance.RECONCILIATION,
            scriptureReference: arg.scriptureReference,
            text: arg.text,
            derivedFromInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );
  }

  /** Отдельно от общего listArguments проекта — тот же принцип, что
   * StakeholderMapService.listByStakeholder(): "показывается как
   * отдельная опция", не смешивается молча с обычными за/против. */
  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.argument.findMany({
      where: { projectId, stance: ArgumentStance.RECONCILIATION },
      orderBy: { createdAt: 'desc' },
    });
  }
}
