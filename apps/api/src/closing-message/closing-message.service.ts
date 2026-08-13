// Пункт 72: ClosingMessageService (§3.35 ТЗ) — "Завершающее сообщение
// — честный итог и уместная цитата", пункт 54 общего списка
// v4-роадмапа. По прямому запросу, найдено полным аудитом.
//
// ТРЕБУЕТ ЗАФИКСИРОВАННОГО DecisionOutcome — без известного исхода
// "честный итог" был бы гаданием, не честностью, отказывает явно, не
// генерирует что-то приблизительное.
//
// ОПИРАЕТСЯ НА РЕАЛЬНЫЕ ArgumentLifecycleStatus=REJECTED/ACCEPTED —
// "аргумент X не был принят" (buкально пример из ТЗ) требует
// конкретных данных, не абстрактной формулировки.
//
// ЦИТАТА — та же дисциплина, что ReconciliationArgumentsService
// (Пункт 49, §3.14): короткий парафраз + ссылка на первоисточник
// ОТДЕЛЬНЫМ полем, только при указанном вероисповедании, никогда не
// подставляется по умолчанию.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentLifecycleStatus } from '@prisma/client';

const TASK_TYPE = 'closing-message';

interface RawClosingMessage {
  summaryText: string;
  quoteText?: string;
  quoteSourceReference?: string;
}

function isValidClosingPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (typeof parsed.summaryText !== 'string' || !parsed.summaryText.trim()) return false;
    // Цитата — либо оба поля присутствуют, либо оба отсутствуют, не частично.
    const hasQuoteText = typeof parsed.quoteText === 'string' && parsed.quoteText.trim().length > 0;
    const hasQuoteSource = typeof parsed.quoteSourceReference === 'string' && parsed.quoteSourceReference.trim().length > 0;
    return hasQuoteText === hasQuoteSource;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT_BASE =
  'Составь короткое ЧЕСТНОЕ завершающее сообщение по итогам решения. Правило — НЕ "никакого негатива", а "не токсично, не унижает, не обвиняет, но честно сообщает об исходе": допустимо сказать "цель не достигнута, вероятная причина — аргумент X не был принят, в следующий раз стоит проверить Y" (конкретно и по делу), НЕДОПУСТИМО говорить "вы плохо провели разговор" (обвинение) или маскировать неудачу нейтральной фразой вроде "есть потенциал для роста". Если результат хороший — дай КОНКРЕТНУЮ, не шаблонную похвалу, опирающуюся на реальные детали ситуации, не общие слова. Используй только переданные тебе конкретные данные (принятые/отклонённые аргументы), не выдумывай причины, которых там нет.';

const SYSTEM_PROMPT_WITH_QUOTE =
  SYSTEM_PROMPT_BASE +
  ' Пользователь указал вероисповедание — ДОПОЛНИТЕЛЬНО подбери ОДНУ короткую, уместную цитату из религиозного первоисточника этой традиции, подходящую именно под этот итог (утешение при неудаче / благодарность при успехе). КРИТИЧЕСКИ ВАЖНО ПО АВТОРСКОМУ ПРАВУ: quoteText — краткий ПАРАФРАЗ своими словами, НЕ дословное цитирование (не длиннее короткой фразы, если вообще дословно), quoteSourceReference — точная ссылка на источник (книга, глава, стих) ОТДЕЛЬНЫМ полем. Ответь СТРОГО валидным JSON вида {"summaryText": string, "quoteText": string, "quoteSourceReference": string}.';

const SYSTEM_PROMPT_NO_QUOTE =
  SYSTEM_PROMPT_BASE + ' Ответь СТРОГО валидным JSON вида {"summaryText": string}. Без пояснений вне JSON.';

@Injectable()
export class ClosingMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(userId: string, projectId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const outcome = await this.prisma.decisionOutcome.findUnique({ where: { projectId } });
    if (!outcome) {
      throw new BadRequestException(
        'Сначала зафиксируйте исход решения (калибровка) — без известного исхода честное завершающее сообщение невозможно, только гадание',
      );
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { religion: true } });

    const [rejected, accepted] = await Promise.all([
      this.prisma.argument.findMany({
        where: { projectId, targetPersonId: null, lifecycleStatus: ArgumentLifecycleStatus.REJECTED },
      }),
      this.prisma.argument.findMany({
        where: { projectId, targetPersonId: null, lifecycleStatus: ArgumentLifecycleStatus.ACCEPTED },
      }),
    ]);

    const rejectedText = rejected.map((a: { text: string }) => a.text).join('\n');
    const acceptedText = accepted.map((a: { text: string }) => a.text).join('\n');

    const userPrompt = [
      `Ситуация: ${project.question}`,
      `Зафиксированный исход: ${outcome.actualOutcome}${outcome.outcomeNotes ? ` (${outcome.outcomeNotes})` : ''}`,
      outcome.predictedLean !== null ? `Ожидаемый уклон аргументации до разговора (по весам): ${outcome.predictedLean}` : '',
      acceptedText ? `Принятые аргументы:\n${acceptedText}` : '',
      rejectedText ? `Отклонённые аргументы:\n${rejectedText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    const systemPrompt = activePrompt?.template ?? (user.religion ? SYSTEM_PROMPT_WITH_QUOTE : SYSTEM_PROMPT_NO_QUOTE);

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 700,
        validateOutput: isValidClosingPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить завершающее сообщение — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawClosingMessage = JSON.parse(result.text);
    // Честная защита: даже если religion не указана, но модель зачем-то
    // вернула цитату (не должна, но не полагаемся только на промпт) —
    // не персистим её, раз согласия на религиозный контент не было.
    const includeQuote = !!user.religion && !!raw.quoteText && !!raw.quoteSourceReference;

    return this.prisma.closingMessage.create({
      data: {
        projectId,
        summaryText: raw.summaryText,
        quoteText: includeQuote ? raw.quoteText! : null,
        quoteSourceReference: includeQuote ? raw.quoteSourceReference! : null,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.closingMessage.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}
