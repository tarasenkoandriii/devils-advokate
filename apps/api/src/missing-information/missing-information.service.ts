// Пункт 16: MissingInformationService (§3.51 ТЗ) — третья из 11 фич
// MVP v2 поверх фундамента.
//
// "Опирается на структуру Decision Objective (3.42) — именно её
// незаполненные поля чаще всего и являются источником недостающей
// информации" — buildUserPrompt() из argument-generation.service.ts
// уже форматирует ИМЕННО этот контекст (question/goal/DecisionObjective)
// для другой фичи (генерация аргументов); переиспользован напрямую как
// export, не продублирован здесь заново — тот же контекст, та же
// сериализация.
//
// НЕ гейт перед другими фичами (проверка ПЕРЕД выдачей рекомендации,
// как буквально написано в ТЗ) — это отдельный AI-вызов по запросу
// пользователя ("Проверить, чего не хватает"), возвращающий список
// вопросов. Принудительная блокировка ArgumentGenerationService или
// других фич до прохождения этой проверки НЕ реализована на этом
// проходе — потребовала бы менять уже существующие сервисы, тогда как
// §3.51 описывает принцип ("сначала уточняющие вопросы, потом анализ"),
// не жёсткий технический гейт с конкретным местом внедрения. Честно
// зафиксировано как out of scope, не встроено молча наполовину.

import { BadGatewayException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { buildUserPrompt } from '../arguments/argument-generation.service';

const TASK_TYPE = 'missing-information-detection';

function isValidQuestionsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string');
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Перед тем как дать рекомендацию по описанной ситуации, определи, какой ключевой информации не хватает для качественного анализа — не додумывай отсутствующие данные, а сформулируй, что нужно уточнить у пользователя. Пример хорошего вопроса: "кто реально принимает решение?", "что произойдёт при отказе?", "какой минимум вас устраивает?", "был ли аналогичный разговор раньше?". Если по описанию видно, что все ключевые поля уже заполнены и данных достаточно — верни пустой массив. Ответь СТРОГО валидным JSON-массивом строк, каждая строка — один уточняющий вопрос. Без пояснений вне JSON.';

@Injectable()
export class MissingInformationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, projectId: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    const objective = await this.prisma.decisionObjective.findUnique({ where: { projectId } });

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt: buildUserPrompt(project, objective),
        jsonMode: true,
        maxTokens: 500,
        validateOutput: isValidQuestionsPayload,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw err;
      }
      throw new BadGatewayException(
        'Не удалось проверить полноту информации — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const questions: string[] = JSON.parse(result.text);

    return this.prisma.missingInformationCheck.create({
      data: {
        projectId,
        questions,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  /** Последний снимок — детекция не мутирует старые записи, каждый
   * вызов detect() создаёт новую (см. обоснование в schema.prisma). */
  async getLatest(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.missingInformationCheck.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
