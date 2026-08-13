// Пункт 45: PrecedentSearchService (§3.9 ТЗ) — реализует ПОЛОВИНУ
// пункта 21 v3-роадмапа. Вторая половина (поиск по публичным
// источникам) СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАНА — подробное обоснование см.
// над моделью BehaviorPrecedent в schema.prisma: это ровно тот
// автономный поиск по конкретному частному человеку, от которого явно
// отказались раньше в этом заходе (диалог перед Пунктом 40). Позиция
// не пересмотрена — реализована только честная половина: прецеденты
// из личных записей пользователя (прошлые разговоры + факты), уже
// сохранённых в приложении.
//
// АГРЕГАЦИЯ ИСТОРИИ — переиспользует тот же паттерн, что уже построен
// в CommunicationProfileService (Пункт 39): все проанализированные
// разговоры, где этот человек участвовал (через participant.personId,
// через ВСЕ проекты пользователя, не только текущий) + PersonFact.
//
// РАЗМЕТКА ПО СХОЖЕСТИ (§3.9 ТЗ) — ANALOGOUS/PARTIALLY_SIMILAR/
// CONTRASTING, буквально из текста. "Итоговый вывод... вероятностная,
// а не голословная оценка" — вычисляется в list() из РЕАЛЬНОГО
// подсчёта уже накопленных прецедентов (не отдельное поле, не
// придумывается заново при каждом обращении).

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, PrecedentSimilarity } from '@prisma/client';

const TASK_TYPE = 'precedent-search';

interface RawPrecedent {
  precedentDescription: string;
  similarity: 'ANALOGOUS' | 'PARTIALLY_SIMILAR' | 'CONTRASTING';
  sourceDescription: string;
}

function isValidPrecedentPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.precedentDescription === 'string' &&
        item.precedentDescription.trim().length > 0 &&
        ['ANALOGOUS', 'PARTIALLY_SIMILAR', 'CONTRASTING'].includes(item.similarity) &&
        typeof item.sourceDescription === 'string' &&
        item.sourceDescription.trim().length > 0,
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе даны прошлые разговоры и известные факты о человеке, а также описание НОВОЙ ситуации. Найди прецеденты — случаи из прошлого, где этот человек вёл себя в похожих или контрастных обстоятельствах. Для каждого найденного прецедента укажи: precedentDescription — конкретно, что он сделал/сказал в том случае, similarity — ANALOGOUS (аналогичный кейс, ситуация очень похожа), PARTIALLY_SIMILAR (частично похожий), или CONTRASTING (контрастный пример — в похожей на первый взгляд ситуации поступил иначе), sourceDescription — на основании какого конкретного разговора или факта сделан вывод. Если данных недостаточно ни для одного прецедента — верни пустой массив. НЕ выдумывай прецеденты, которых нет в данных. Ответь СТРОГО валидным JSON-массивом объектов вида {"precedentDescription": string, "similarity": "ANALOGOUS"|"PARTIALLY_SIMILAR"|"CONTRASTING", "sourceDescription": string}. Без пояснений вне JSON.';

@Injectable()
export class PrecedentSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async findPrecedents(userId: string, personId: string, situationDescription: string, engineId?: string) {
    const person = await this.assertOwnedPerson(userId, personId);
    if (!situationDescription.trim()) {
      throw new BadRequestException('situationDescription не может быть пустым — нужно знать, для какой ситуации искать прецедент');
    }

    const [facts, conversations] = await Promise.all([
      this.prisma.personFact.findMany({ where: { personId, status: 'ACTIVE' } }),
      this.prisma.conversation.findMany({
        where: {
          status: { in: [ConversationProcessingStatus.TRANSCRIBED, ConversationProcessingStatus.ANALYZED] },
          participants: { some: { personId } },
        },
        include: { transcript: { include: { segments: { where: { participant: { personId } } } } } },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);

    if (facts.length === 0 && conversations.length === 0) {
      throw new BadRequestException(
        `Person ${personId} has no facts or analyzed conversations yet — nothing to search for precedents in`,
      );
    }

    const factsSummary = facts.length > 0 ? facts.map((f: { content: string }) => `- ${f.content}`).join('\n') : '(фактов нет)';
    const conversationsSummary = conversations
      .map((c: any) => {
        const text = (c.transcript?.segments ?? []).map((s: any) => s.text).join(' ');
        return text ? `(${c.occurredAt.toISOString().slice(0, 10)}) ${text}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    const userPrompt = `Известные факты о человеке:\n${factsSummary}\n\nЕго реплики из прошлых разговоров:\n${conversationsSummary || '(реплик пока нет)'}\n\nНовая ситуация, для которой нужен прецедент: ${situationDescription}`;

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidPrecedentPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось найти прецеденты — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawPrecedents: RawPrecedent[] = JSON.parse(result.text);
    return this.prisma.$transaction(
      rawPrecedents.map((p) =>
        this.prisma.behaviorPrecedent.create({
          data: {
            personId,
            situationDescription,
            precedentDescription: p.precedentDescription,
            similarity: p.similarity as PrecedentSimilarity,
            sourceDescription: p.sourceDescription,
            generatedByInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );
  }

  /** "Итоговый вывод по фигуранту... вероятностная, а не голословная
   * оценка" (§3.9 ТЗ) — вычисляется из РЕАЛЬНОГО накопленного числа
   * прецедентов по каждой категории схожести, не придумывается заново. */
  async list(userId: string, personId: string) {
    await this.assertOwnedPerson(userId, personId);
    const precedents = await this.prisma.behaviorPrecedent.findMany({
      where: { personId },
      orderBy: { createdAt: 'desc' },
    });

    const total = precedents.length;
    const analogousCount = precedents.filter((p: { similarity: string }) => p.similarity === 'ANALOGOUS').length;
    const conclusion =
      total > 0
        ? `Найдено ${total} прецедент(ов), из них ${analogousCount} — аналогичные ситуации ("в похожих ситуациях ${analogousCount} из ${total} раз(а) вёл себя схожим образом").`
        : 'Прецедентов пока не найдено.';

    return { precedents, total, analogousCount, conclusion };
  }

  private async assertOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}
