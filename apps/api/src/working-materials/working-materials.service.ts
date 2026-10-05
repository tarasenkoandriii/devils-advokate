// Пункт 60: WorkingMaterialsService (§3.27 ТЗ) — "Материалы для
// спарринга: критика и итеративная доработка", v4-роадмап (пункт 46
// общего списка), реализован в честно суженном объёме после
// обсуждения с пользователем. См. подробное обоснование двух
// осознанно не реализованных фрагментов (фото/графики, голосовой
// режим) над моделью WorkingMaterial в schema.prisma.
//
// "ПЕРВОИСТОЧНИКИ НА СЕРВЕР НЕ ПЕРЕДАЮТСЯ" — buкально ТЗ. Этот
// сервис НИКОГДА не получает файл, только extractedText — уже
// извлечённый на клиенте текст. Нет ни multipart-обработки, ни
// File-параметров нигде в этом файле, в отличие от, например,
// PersonFactsService/PhotoVerificationService.

import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

/** Сколько раз пересчитывать номер версии на занятом номере. Три —
 * потому что параллельных правок одного материала одним человеком
 * бывает две-три, а не двадцать; предел нужен, чтобы потеря разбора не
 * превратилась в зависший запрос. */
const VERSION_INSERT_ATTEMPTS = 3;
import { isUniqueViolation } from '../common/unique-violation';
import { activePromptVersion } from '../common/active-prompt-version';

const TASK_TYPE = 'working-material-critique';

interface RawCritique {
  critique: string;
  editPrompt: string;
}

function isValidCritiquePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.critique === 'string' &&
      parsed.critique.trim().length > 0 &&
      typeof parsed.editPrompt === 'string' &&
      parsed.editPrompt.trim().length > 0
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе дан текст рабочего материала (извлечён из .md-файла или презентации PPTX) и контекст предстоящей беседы — вопрос и цель пользователя. Дай КОНКРЕТНУЮ критику, привязанную именно к контексту этой беседы, не абстрактный разбор стиля — например, укажи, какой именно пункт материала ослабляет позицию пользователя в ЭТОЙ КОНКРЕТНОЙ ситуации, и почему. Затем сгенерируй ГОТОВЫЙ ПРОМПТ, который пользователь сможет скормить редактирующему AI-инструменту (текстовому), чтобы внести именно те правки, которые нужны под эту беседу — промпт должен быть конкретным, не общим "улучши текст". Ответь СТРОГО валидным JSON-объектом вида {"critique": string, "editPrompt": string}. Без пояснений вне JSON.';

@Injectable()
export class WorkingMaterialsService {
  private readonly logger = new Logger(WorkingMaterialsService.name);

  /** Вставить версию, пересчитав номер, если его занял параллельный
   * вызов. Пункт [check-then-create-2] 2026-09-27.
   *
   * Попыток ограниченное число: бесконечный цикл на занятом номере
   * превратил бы потерю разбора в зависший запрос, а это хуже. Если не
   * удалось и после них — отказ пробрасывается как есть, потому что
   * выдумывать номер дальше значит гадать. */
  private async insertVersion(
    workingMaterialId: string,
    firstTry: number,
    payload: { extractedText: string; critique: string; editPrompt: string; generatedByInferenceId: string | null },
  ) {
    let versionNumber = firstTry;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.materialVersion.create({
          data: { workingMaterialId, versionNumber, ...payload },
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= VERSION_INSERT_ATTEMPTS) throw err;
        const last = await this.prisma.materialVersion.findFirst({
          where: { workingMaterialId },
          orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        });
        const next = (last?.versionNumber ?? 0) + 1;
        // Номер обязан вырасти: иначе следующая попытка повторит ту же
        // вставку и тот же отказ, и цикл крутился бы до предела впустую.
        versionNumber = next > versionNumber ? next : versionNumber + 1;
        this.logger.warn(
          `Версия материала ${workingMaterialId}: номер ${firstTry} занят параллельной правкой, ` +
            `разбор сохраняется под номером ${versionNumber} (попытка ${attempt + 1} из ${VERSION_INSERT_ATTEMPTS})`,
        );
      }
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** Без materialId — создаёт новый WorkingMaterial + первую версию.
   * С materialId — добавляет следующую версию к уже существующему
   * ("итеративный цикл: подгружает исправленную версию → получает
   * новый разбор", буквально ТЗ). */
  async submitVersion(
    userId: string,
    projectId: string,
    extractedText: string,
    materialId?: string,
    title?: string,
    engineId?: string,
  ) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    if (!extractedText.trim()) {
      throw new BadRequestException('extractedText не может быть пустым');
    }

    let material;
    let nextVersionNumber: number;
    if (materialId) {
      material = await this.prisma.workingMaterial.findFirst({ where: { id: materialId, projectId } });
      if (!material) {
        throw new NotFoundException(`WorkingMaterial ${materialId} not found in project ${projectId}`);
      }
      const lastVersion = await this.prisma.materialVersion.findFirst({
        where: { workingMaterialId: material.id },
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
      });
      nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;
    } else {
      if (!title?.trim()) {
        throw new BadRequestException('title обязателен при создании нового материала');
      }
      material = await this.prisma.workingMaterial.create({ data: { projectId, title: title.trim() } });
      nextVersionNumber = 1;
    }

    const userPrompt = [
      `Вопрос/ситуация: ${project.question}`,
      project.goal ? `Цель предстоящей беседы: ${project.goal}` : '(цель проекта пока не указана — критика будет более общей)',
      `Текст материала (версия ${nextVersionNumber}):\n${extractedText.trim()}`,
    ].join('\n\n');

    const activePrompt = await activePromptVersion(this.prisma, TASK_TYPE);

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
        maxTokens: 1500,
        validateOutput: isValidCritiquePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось получить разбор материала — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawCritique = JSON.parse(result.text);
    // Пункт [check-then-create-2] 2026-09-27. Здесь окно между «узнать
    // номер следующей версии» и «вставить её» — не миллисекунды, а ВЕСЬ
    // вызов модели: десятки секунд. Две правки одного материала подряд
    // получали один и тот же номер, и вторая падала на
    // `@@unique([workingMaterialId, versionNumber])` — после того как
    // разбор уже сделан и оплачен. Человек терял готовую работу и видел
    // внутреннюю ошибку.
    //
    // `upsert` тут был бы НЕВЕРЕН и опаснее самой гонки: он перезаписал
    // бы чужую версию её критикой, то есть потерял бы уже сохранённый
    // разбор молча. Правильный ответ — пересчитать номер и вставить
    // снова: критика на руках, терять нечего.
    const version = await this.insertVersion(material.id, nextVersionNumber, {
      extractedText: extractedText.trim(),
      critique: raw.critique,
      editPrompt: raw.editPrompt,
      generatedByInferenceId: result.aiInferenceId,
    });

    return { material, version };
  }

  /** "Лог итераций" — материал со всеми версиями по порядку. */
  async getMaterial(userId: string, projectId: string, materialId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const material = await this.prisma.workingMaterial.findFirst({
      where: { id: materialId, projectId },
      include: { versions: { orderBy: [{ versionNumber: 'asc' }, { id: 'asc' }] } },
    });
    if (!material) {
      throw new NotFoundException(`WorkingMaterial ${materialId} not found in project ${projectId}`);
    }
    return material;
  }

  async listMaterials(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.workingMaterial.findMany({
      where: { projectId },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
