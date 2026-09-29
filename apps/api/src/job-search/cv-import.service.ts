// Пункт [job-domain-v2] К-22 + приёмка 40 — импорт СУЩЕСТВУЮЩЕГО резюме.
//
// НАЙДЕНО АУДИТОМ 2026-09-03: К-22 числился в реестре §12 и в поле схемы
// `cvDraftEvidence`, но кода не было вовсе — CV рождалось только из
// онбординг-разговора. Человеку с готовым резюме продукт предлагал
// пересказать его голосом заново.
//
// ПОЧЕМУ ЭТО НЕ «ПРОСТО РАСПАРСИТЬ». Главное обещание домена — «CV только из
// ваших слов». У импорта это обещание превращается в проверяемое: каждый
// элемент черновика обязан ссылаться на ДОСЛОВНУЮ цитату из принесённого
// документа. Модель, которая «улучшила» формулировку или добавила ровный
// круглый показатель, оставляет элемент без опоры — и он не проходит
// утверждение (400 со списком). Пользователь либо правит черновик руками,
// либо возвращает фразу из документа; тихо утвердить придуманное нельзя.
//
// Формат путей элементов — свой, не `resolveHighlightRef` из CV-варианта:
// там адресуются только подсвечиваемые фрагменты, а здесь под опорой должны
// быть и места работы целиком (`experience[i]` — период, компания, роль),
// то есть ровно те утверждения, которые проверяет работодатель.

import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { BadGatewayException } from '@nestjs/common';
import type { CvDraft } from './job-search.service';
import { CvDraftEvidence, describePath, missingEvidencePaths, sanitizeCvEvidence } from './cv-evidence';

export const CV_IMPORT_TASK_TYPE = 'job-search-cv-import';
export const MAX_IMPORT_CHARS = 20_000;

export const CV_IMPORT_SYSTEM_PROMPT =
  'Тебе дан текст ГОТОВОГО резюме кандидата. Разбери его в структуру и для КАЖДОГО элемента приведи дословную цитату из этого текста, на которой элемент основан. ' +
  'Структура: headline (одна строка), summary, skills[], experience[{period, place, role, highlights[]}], education[]. ' +
  'ЗАПРЕЩЕНО: переписывать формулировки «красивее», добавлять навыки, места работы, достижения, цифры или образование, которых в тексте нет, и придумывать периоды. ' +
  'Если чего-то в резюме нет — оставь секцию пустой. Цитата обязана встречаться в тексте ДОСЛОВНО (подстрокой), иначе элемент будет отброшен. ' +
  'Пути элементов: "headline", "summary", "skills[i]", "education[i]", "experience[i]" (для периода/компании/роли), "experience[i].highlights[j]". ' +
  'Ответь СТРОГО валидным JSON вида {"draft": {"headline": string, "summary": string, "skills": string[], "experience": [{"period": string, "place": string, "role": string, "highlights": string[]}], "education": string[]}, ' +
  '"evidence": [{"path": string, "quote": string}]}. Без пояснений вне JSON.';

function isValidImportPayload(text: string): boolean {
  try {
    const p = JSON.parse(text);
    const d = p?.draft;
    if (typeof d !== 'object' || d === null) return false;
    if (typeof d.headline !== 'string' || typeof d.summary !== 'string') return false;
    if (!Array.isArray(d.skills) || !d.skills.every((s: unknown) => typeof s === 'string')) return false;
    if (!Array.isArray(d.education) || !d.education.every((s: unknown) => typeof s === 'string')) return false;
    if (!Array.isArray(d.experience)) return false;
    if (!d.experience.every((e: any) => typeof e?.period === 'string' && typeof e?.place === 'string' && typeof e?.role === 'string' && Array.isArray(e?.highlights) && e.highlights.every((h: unknown) => typeof h === 'string'))) return false;
    return Array.isArray(p?.evidence);
  } catch {
    return false;
  }
}

@Injectable()
export class CvImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  private async config(userId: string, projectId: string) {
    const config = await this.prisma.jobSearchConfig.findFirst({
      where: { projectId, project: { ownerId: userId } },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) throw new BadRequestException(`Поиск работы для этого проекта не настроен`);
    return config;
  }

  /** К-22: документ → черновик CV с опорой на цитаты. Утверждение —
   * отдельным действием и только когда каждый элемент опирается на документ. */
  async importCv(userId: string, projectId: string, dto: { text: string; sourceRef?: string | null }) {
    const config = await this.config(userId, projectId);
    const document = dto.text.slice(0, MAX_IMPORT_CHARS);
    if (document.trim().length < 40) throw new BadRequestException('Текст резюме слишком короткий — импортировать нечего');

    let text: string;
    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: CV_IMPORT_TASK_TYPE,
        systemPrompt: CV_IMPORT_SYSTEM_PROMPT,
        userPrompt: `Текст резюме:\n${document}`,
        jsonMode: true,
        maxTokens: 3000,
        validateOutput: isValidImportPayload,
      });
      text = result.text;
    } catch (err) {
      rethrowClientVisibleAiError(err);
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Разбор резюме отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось разобрать резюме — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const payload = JSON.parse(text) as { draft: CvDraft; evidence: unknown };
    const draft = payload.draft;
    const items = sanitizeCvEvidence(payload.evidence, draft, document);
    const missing = missingEvidencePaths(draft, items);
    const evidence: CvDraftEvidence = {
      sourceRef: dto.sourceRef?.slice(0, 200) ?? null,
      importedAt: new Date().toISOString(),
      sourceText: document,
      items,
    };

    const updated = await this.prisma.jobSearchConfig.update({
      where: { id: config.id },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
      data: {
        cvDraft: draft as never,
        cvDraftEvidence: evidence as never,
        cvDraftedAt: new Date(),
        // Импорт — новый черновик: прежнее утверждение к нему не относится.
        cvReviewedAt: null,
        cvText: null,
      },
    });

    return {
      config: updated,
      evidenceCount: items.length,
      missing: missing.map((p) => ({ path: p, label: describePath(p, draft) })),
      note:
        missing.length === 0
          ? 'Каждый элемент черновика опирается на цитату из вашего документа.'
          : 'Эти элементы не нашлись в тексте документа дословно. Приложение их не выбрасывает — но и утвердить CV с ними не даст: поправьте формулировку под документ или удалите их.',
    };
  }

  /** Правка импортированного черновика руками: пользователь убирает то, что
   * разбор придумал, или возвращает фразу из документа. Опоры пересчитываются
   * по тому же документу — «подтвердить» нельзя, отредактировав только текст. */
  async updateDraft(userId: string, projectId: string, draft: CvDraft) {
    const config = await this.config(userId, projectId);
    const stored = config.cvDraftEvidence as unknown as CvDraftEvidence | null;
    if (!stored?.sourceText) throw new BadRequestException('Черновик не импортирован из документа — правка через этот маршрут не применяется');
    const items = sanitizeCvEvidence(stored.items, draft, stored.sourceText);
    const missing = missingEvidencePaths(draft, items);
    const updated = await this.prisma.jobSearchConfig.update({
      where: { id: config.id },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
      data: {
        cvDraft: draft as never,
        cvDraftEvidence: { ...stored, items } as never,
        cvReviewedAt: null,
        cvText: null,
      },
    });
    return { config: updated, evidenceCount: items.length, missing: missing.map((p) => ({ path: p, label: describePath(p, draft) })) };
  }

}
