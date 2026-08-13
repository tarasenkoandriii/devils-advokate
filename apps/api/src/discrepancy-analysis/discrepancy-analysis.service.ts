// Пункт 37: DiscrepancyAnalysisService (§3.16 ТЗ) — вторая из трёх фич
// MVP v3, отобранных как готовые СЕЙЧАС без новой инфраструктуры.
//
// ЧЕСТНО ОГРАНИЧЕННЫЙ ОБЪЁМ — ТЗ описывает сверку по ЧЕТЫРЁМ
// источникам: (1) база аргументации проекта, (2) прошлые беседы с тем
// же фигурантом, (3) внутренняя непротиворечивость в пределах этого
// разговора, (4) публично доступные факты. Реализованы (1)-(3) —
// используют уже существующую инфраструктуру (Argument, история
// разговоров через participant.personId, транскрипт текущего
// разговора). (4) НЕ реализовано — требует внешнего поиска
// (веб-поиск/OSINT), которого в развёрнутом приложении нет вообще
// (у меня как у Claude есть web_search, но это НЕ то же самое, что
// возможность деплойнутого AIRouterService — тот умеет только вызывать
// LLM-провайдеров, не поисковые системы). Честно исключено, не
// притворяется реализованным через AI-догадку без реального источника.
//
// НОВАЯ Prisma-модель НЕ заводилась — та же логика, что уже
// применялась к Turning Points/Manipulation Detector: ConversationSignal
// (signalType=FACTUAL_DISCREPANCY, severity=INACCURACY|DISCREPANCY|
// STRONG_DISCREPANCY, userConfirmedIntentionalFalsehood) — все нужные
// поля существовали в схеме с чекпоинта 1, ни разу не заполнялись ни
// одним сервисом до этого прохода (тот же класс пробела, что уже
// находился раньше: модель/enum есть, сервиса-создателя нет).
//
// ОБЯЗАТЕЛЬНОЕ ПРАВИЛО ИСТОЧНИКА (§3.16 ТЗ: "discrepancy и
// strong_discrepancy ставятся ТОЛЬКО при наличии конкретной ссылки на
// источник") — ConversationSignalEvidence поддерживает только три
// типа ссылки (personFactId/observationId/aiInferenceId), НЕТ прямой
// связи на Argument или TranscriptSegment из ДРУГОГО разговора. Решено
// тем же способом, что уже используется ВЕЗДЕ в этом проекте для
// текстовых обоснований (Turning Points/Do Not Say/Manipulation
// Detector) — источник описывается ТЕКСТОМ внутри AIInference.output
// (какой именно аргумент/какая именно прошлая беседа), не отдельной
// структурной FK-ссылкой. INACCURACY без источника — допустима
// (§3.16: "без источника — не выше уровня «требует проверки»").
//
// МНОГОСОБЕСЕДНИКОВОСТЬ (§3.16: "утверждения одного собеседника не
// сверяются с историей другого") — ОДИН AI-вызов на весь разговор
// (не N вызовов на N говорящих — дороже, без явной необходимости), но
// промпт явно инструктирует: сверять реплики каждого говорящего
// только с ЕГО СОБСТВЕННОЙ историей (если участник сопоставлен
// конкретному Person — Пункт 26) и внутри разговора — только с ЕГО
// ЖЕ другими репликами, не путать говорящих между собой.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSignalType, SignalSeverity } from '@prisma/client';
import { fetchUrlText, UnsafeUrlError, UrlFetchError } from '../common/safe-url-fetch';

const TASK_TYPE = 'discrepancy-analysis';
const PRIOR_CONVERSATIONS_LIMIT = 5; // тот же лимит и то же обоснование, что ConversationAgendaService — не раздувать промпт бесконечно на давних фигурантах

interface RawDiscrepancy {
  segmentId: string;
  severity: 'INACCURACY' | 'DISCREPANCY' | 'STRONG_DISCREPANCY';
  sourceDescription: string; // текстовое описание источника расхождения — обязательно для DISCREPANCY/STRONG_DISCREPANCY, см. isValidDiscrepancyPayload()
  potentialImpact: string; // Пункт 42: для чего нужна проверка / на что может повлиять / риск эскалации — заполняется тем же AI-вызовом, что и остальные поля, не отдельным запросом при экспорте
}

function isValidDiscrepancyPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every((item) => {
      if (
        typeof item.segmentId !== 'string' ||
        !['INACCURACY', 'DISCREPANCY', 'STRONG_DISCREPANCY'].includes(item.severity) ||
        typeof item.sourceDescription !== 'string' ||
        typeof item.potentialImpact !== 'string' ||
        item.potentialImpact.trim().length === 0
      ) {
        return false;
      }
      // §3.16 ТЗ — обязательное правило источника: без конкретного
      // описания источника DISCREPANCY/STRONG_DISCREPANCY недопустимы.
      // Проверяется здесь, до записи в БД, не полагаемся на то, что AI
      // сам всегда соблюдёт инструкцию из промпта.
      if (item.severity !== 'INACCURACY' && item.sourceDescription.trim().length === 0) {
        return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты проверяешь транскрипт разговора на расхождения слов говорящих с источниками. Тебе даны: реплики разговора (с id, говорящим и текстом), база аргументов проекта, и для некоторых говорящих — их прошлые разговоры (если есть). Проверь каждую реплику на три типа расхождений: (1) со СВОИМИ ЖЕ прошлыми словами в прошлых разговорах (если есть история для этого говорящего), (2) с базой аргументов проекта, (3) с внутренней логикой — не противоречит ли говорящий сам себе в ПРЕДЕЛАХ ЭТОГО ЖЕ разговора. ВАЖНО: сверяй реплики каждого говорящего только с ЕГО СОБСТВЕННОЙ историей — никогда не сверяй слова одного говорящего с историей или репликами другого. Шкала: INACCURACY — незначительное расхождение, может быть ошибкой памяти (источник не обязателен); DISCREPANCY — прямо расходится с ранее сказанным или зафиксированным, но без уверенности в причине (источник ОБЯЗАТЕЛЕН); STRONG_DISCREPANCY — прямо и однозначно противоречит источнику с высокой уверенностью (источник ОБЯЗАТЕЛЕН). Для DISCREPANCY/STRONG_DISCREPANCY sourceDescription должен содержать конкретное указание источника (например "в разговоре от 12.03.2026 говорил обратное" или "противоречит аргументу проекта: ..."). Также для КАЖДОЙ найденной точки укажи potentialImpact — коротко, для чего пользователю важно это проверить: на что может повлиять подтверждение расхождения (доверие к другим заявлениям, конкретное решение в переговорах и т.д.) и есть ли риск, что поднятие этой темы обострит конфликт — оцени честно, не преувеличивай. НИКОГДА не утверждай, что человек солгал — только то, что расходится с источником X. Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "severity": "INACCURACY"|"DISCREPANCY"|"STRONG_DISCREPANCY", "sourceDescription": string, "potentialImpact": string}. Если расхождений нет — верни пустой массив []. Без пояснений вне JSON.';

// Пункт 40 — четвёртый источник сверки §3.16 ТЗ ("публично доступные
// факты"), НЕ автономный поиск: пользователь сам указывает URL,
// сервер скачивает ИМЕННО ЕГО (не решает, что искать). Отдельный
// taskType/промпт/интерфейс — задача принципиально другой формы (один
// конкретный сегмент против одного конкретного источника, не батч по
// всему транскрипту), не расширение detect().
const SOURCE_CHECK_TASK_TYPE = 'discrepancy-source-check';

interface RawSourceCheckResult {
  outcome: 'CONFIRMED' | 'CONTRADICTED' | 'INSUFFICIENT';
  severity?: 'INACCURACY' | 'DISCREPANCY' | 'STRONG_DISCREPANCY';
  explanation: string;
  potentialImpact?: string; // Пункт 42: обязателен только при outcome=CONTRADICTED, тот же принцип, что и severity
}

function isValidSourceCheckPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (!['CONFIRMED', 'CONTRADICTED', 'INSUFFICIENT'].includes(parsed.outcome)) return false;
    if (typeof parsed.explanation !== 'string' || parsed.explanation.trim().length === 0) return false;
    if (parsed.outcome === 'CONTRADICTED') {
      if (!['INACCURACY', 'DISCREPANCY', 'STRONG_DISCREPANCY'].includes(parsed.severity)) return false;
      if (typeof parsed.potentialImpact !== 'string' || parsed.potentialImpact.trim().length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SOURCE_CHECK_PROMPT =
  'Тебе дано утверждение из разговора и текст веб-страницы, которую пользователь сам указал как источник для проверки. Определи: CONFIRMED — источник подтверждает утверждение или согласуется с ним; CONTRADICTED — источник прямо противоречит утверждению (в этом случае укажи severity: INACCURACY для незначительного расхождения, DISCREPANCY для явного противоречия без уверенности в причине, STRONG_DISCREPANCY для однозначного противоречия с высокой уверенностью, и potentialImpact — коротко, для чего важно это проверить: на что может повлиять подтверждение расхождения, есть ли риск эскалации при обсуждении); INSUFFICIENT — текст источника не даёт достаточно информации, чтобы сравнить (не то же самое, что "нет противоречия" — просто нечем сравнить). НИКОГДА не утверждай, что человек солгал — только то, расходится ли утверждение с текстом ИМЕННО ЭТОГО источника. Ответь СТРОГО валидным JSON-объектом вида {"outcome": "CONFIRMED"|"CONTRADICTED"|"INSUFFICIENT", "severity": string, "explanation": string, "potentialImpact": string}. Поля severity/potentialImpact включай только при outcome=CONTRADICTED. Без пояснений вне JSON.';

@Injectable()
export class DiscrepancyAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (
      conversation.status !== ConversationProcessingStatus.TRANSCRIBED &&
      conversation.status !== ConversationProcessingStatus.ANALYZED
    ) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before discrepancy analysis (current: ${conversation.status})`,
      );
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Conversation ${conversationId} has no transcript segments to analyze`);
    }

    const [arguments_, priorConversationsByPerson] = await Promise.all([
      this.prisma.argument.findMany({ where: { projectId: conversation.projectId } }),
      this.buildPriorConversationsByPerson(conversation.projectId, conversationId, segments),
    ]);

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;

    const argumentsContext =
      arguments_.length > 0
        ? `База аргументов проекта:\n${arguments_.map((a: { text: string; stance: string }) => `(${a.stance}) ${a.text}`).join('\n')}\n\n`
        : '';
    const historyContext = [...priorConversationsByPerson.entries()]
      .map(([personId, text]) => `История говорящего [personId=${personId}]:\n${text}`)
      .join('\n\n');
    const transcriptText = segments
      .map(
        (s: (typeof segments)[number]) =>
          `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}${s.participant?.personId ? ` (personId=${s.participant.personId})` : ''}: ${s.text}`,
      )
      .join('\n');
    const userPrompt = `${argumentsContext}${historyContext ? historyContext + '\n\n' : ''}Транскрипт текущего разговора:\n${transcriptText}`;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidDiscrepancyPayload,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось проверить разговор на расхождения — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawPoints: RawDiscrepancy[] = JSON.parse(result.text);
    const segmentById = new Map<string, (typeof segments)[number]>(
      segments.map((s: (typeof segments)[number]): [string, (typeof segments)[number]] => [s.id, s]),
    );

    const created = [];
    for (const point of rawPoints) {
      const segment = segmentById.get(point.segmentId);
      if (!segment) continue; // AI сослался на несуществующий id реплики — пропускаем, не падаем на всём батче

      const signal = await this.prisma.conversationSignal.create({
        data: {
          signalType: ConversationSignalType.FACTUAL_DISCREPANCY,
          transcriptSegmentId: segment.id,
          participantId: segment.participantId,
          severity: point.severity as SignalSeverity,
        },
      });
      await this.prisma.conversationSignalEvidence.create({
        data: { conversationSignalId: signal.id, aiInferenceId: result.aiInferenceId },
      });
      created.push({ ...signal, segment, sourceDescription: point.sourceDescription });
    }

    return created;
  }

  /** Список уже найденных расхождений (без нового AI-вызова) —
   * восстанавливает sourceDescription из общего AIInference.output по
   * segmentId, тот же паттерн, что у остальных детекторов этого чекпоинта. */
  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segmentIds = (conversation.transcript?.segments ?? []).map((s: { id: string }) => s.id);
    if (segmentIds.length === 0) return [];

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: ConversationSignalType.FACTUAL_DISCREPANCY,
        transcriptSegmentId: { in: segmentIds },
      },
      include: {
        transcriptSegment: true,
        evidence: { include: { aiInference: true } },
      },
    });

    const segmentOrder = new Map<string, number>(
      segmentIds.map((id: string, i: number): [string, number] => [id, i]),
    );
    return signals
      .map((signal: any) => ({ ...signal, ...this.resolveSignalDetails(signal) }))
      .sort(
        (a: any, b: any) =>
          (segmentOrder.get(a.transcriptSegmentId ?? '') ?? 0) -
          (segmentOrder.get(b.transcriptSegmentId ?? '') ?? 0),
      );
  }

  /** §3.16 ТЗ: "система никогда не проставляет [userConfirmedIntentionalFalsehood]
   * самостоятельно" — единственный способ его выставить, отдельным
   * ручным действием пользователя, не побочным эффектом detect(). */
  async confirmIntentionalFalsehood(userId: string, signalId: string) {
    const signal = await this.findOwnedSignal(userId, signalId);
    return this.prisma.conversationSignal.update({
      where: { id: signalId },
      data: { userConfirmedIntentionalFalsehood: true },
    });
  }

  /** Пункт 40 — закрывает четвёртый источник сверки §3.16 ТЗ
   * ("публично доступные факты"), явно исключённый в Пункте 37 как
   * требующий автономного веб-поиска, которого в приложении нет. НЕ
   * автономный поиск — пользователь САМ указывает конкретную ссылку,
   * сервер только скачивает ИМЕННО ЕЁ (safeUrlFetch.ts, с SSRF-
   * защитой) и сравнивает с ней. Решение принято отдельно, не по
   * умолчанию: автономный AI-поиск по имени человека — инструмент
   * слежки за конкретным частным лицом вне зависимости от упаковки
   * (см. диалог, приведший к этому пункту); ручная вставка источника
   * пользователем оставляет выбор "что и где искать" полностью за
   * ним, не за системой. */
  async checkAgainstUserSource(userId: string, conversationId: string, segmentId: string, url: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segment = (conversation.transcript?.segments ?? []).find((s: { id: string }) => s.id === segmentId);
    if (!segment) {
      throw new NotFoundException(`TranscriptSegment ${segmentId} not found in conversation ${conversationId}`);
    }

    let sourceText: string;
    try {
      sourceText = await fetchUrlText(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const userPrompt = `Утверждение из разговора: "${segment.text}"\n\nТекст страницы по ссылке, которую пользователь сам указал как источник для проверки:\n${sourceText}`;

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: SOURCE_CHECK_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SOURCE_CHECK_PROMPT;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: SOURCE_CHECK_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidSourceCheckPayload,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException(
        'Не удалось сверить утверждение с источником — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const parsed: RawSourceCheckResult = JSON.parse(result.text);

    // Сигнал создаётся ТОЛЬКО при реальном противоречии — "источник
    // подтверждает" или "источника недостаточно" не создают запись в
    // ConversationSignal, только информационный ответ пользователю.
    let signal = null;
    if (parsed.outcome === 'CONTRADICTED') {
      signal = await this.prisma.conversationSignal.create({
        data: {
          signalType: ConversationSignalType.FACTUAL_DISCREPANCY,
          transcriptSegmentId: segment.id,
          participantId: segment.participantId,
          severity: parsed.severity as SignalSeverity,
        },
      });
      await this.prisma.conversationSignalEvidence.create({
        data: { conversationSignalId: signal.id, aiInferenceId: result.aiInferenceId },
      });
    }

    return {
      outcome: parsed.outcome,
      explanation: parsed.explanation,
      sourceUrl: url,
      signal: signal ? { ...signal, sourceDescription: `Источник по ссылке, указанной пользователем: ${url} — ${parsed.explanation}` } : null,
    };
  }

  /** Пункт 41 — по прямому запросу, альтернатива автономному поиску:
   * НЕ ищет ничего сама, только форматирует уже известные приложению
   * данные (сигналы FACTUAL_DISCREPANCY из detect()/checkAgainstUserSource())
   * в пронумерованный текстовый список, который пользователь уносит
   * куда угодно — свой поиск, суд, показать кому-то — полностью вне
   * поисковой машинерии приложения. Тот же принцип границы
   * ответственности, что уже применялся к checkAgainstUserSource()
   * (Пункт 40): выбор "что и как проверять" остаётся полностью за
   * пользователем, система не решает это за него.
   *
   * "Требует проверки" — буквальная формулировка §3.16 ТЗ ("без
   * источника — расхождение не выше уровня «требует проверки»") —
   * применена здесь к критерию отбора: сигнал считается ТРЕБУЮЩИМ
   * проверки, если у него ещё нет sourceDescription от реальной
   * проверки через checkAgainstUserSource() (текст из detect() —
   * AI-догадка о том, ГДЕ искать расхождение, не подтверждённый
   * источник сам по себе).
   *
   * Пункт 42 — по прямому запросу, формат строки списка: сначала
   * уровень важности (и сортировка ПО НЕМУ, не по порядку реплик в
   * разговоре — самое серьёзное сверху), затем сам факт, в конце в
   * скобках — potentialImpact (для чего нужна проверка/на что может
   * повлиять/риск эскалации), заполненный тем же AI-вызовом, что уже
   * определяет severity — не отдельным запросом ради экспорта. */
  async exportFactsToVerify(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segmentIds = (conversation.transcript?.segments ?? []).map((s: { id: string }) => s.id);
    if (segmentIds.length === 0) {
      return { text: 'В этом разговоре пока нет расшифрованных реплик.', count: 0 };
    }

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: ConversationSignalType.FACTUAL_DISCREPANCY,
        transcriptSegmentId: { in: segmentIds },
      },
      include: {
        transcriptSegment: { include: { participant: { include: { person: true } } } },
        evidence: { include: { aiInference: true } },
      },
    });

    // Важность — не порядок реплик в разговоре. Чем серьёзнее
    // расхождение, тем меньше ранг (0 — самое важное, сортировка по
    // возрастанию ставит его первым).
    const SEVERITY_RANK: Record<string, number> = { STRONG_DISCREPANCY: 0, DISCREPANCY: 1, INACCURACY: 2 };
    const sorted = signals
      .map((signal: any) => ({ ...signal, ...this.resolveSignalDetails(signal) }))
      .sort((a: any, b: any) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99));

    if (sorted.length === 0) {
      return { text: 'В этом разговоре расхождений не найдено — нечего выгружать.', count: 0 };
    }

    const SEVERITY_LABELS: Record<string, string> = {
      INACCURACY: 'НЕТОЧНОСТЬ',
      DISCREPANCY: 'ПРОТИВОРЕЧИЕ',
      STRONG_DISCREPANCY: 'СИЛЬНОЕ РАСХОЖДЕНИЕ',
    };

    // "Проверено вручную" — это ТОЛЬКО checkAgainstUserSource() с
    // реальной ссылкой (текст содержит "Источник по ссылке,
    // указанной пользователем" — тот же литерал, что записывается
    // при создании такого сигнала). Не путать с текстом из detect() —
    // тот описывает, ГДЕ AI РЕКОМЕНДУЕТ искать, не факт проверки.
    const lines: string[] = [];
    let toVerifyCount = 0;
    sorted.forEach((signal: any, i: number) => {
      const speaker = signal.transcriptSegment?.participant?.person?.displayName
        ?? signal.transcriptSegment?.participant?.diarizationLabel
        ?? 'Говорящий';
      const statement = signal.transcriptSegment?.text ?? '(текст реплики недоступен)';
      const severityLabel = SEVERITY_LABELS[signal.severity as string] ?? signal.severity;
      const wasManuallyChecked = signal.sourceDescription?.includes('Источник по ссылке, указанной пользователем');
      const impactText = signal.potentialImpact ?? 'влияние не оценено AI при обнаружении';

      // Требуемый порядок в строке: важность → факт → влияние в скобках.
      lines.push(`${i + 1}. [${severityLabel}] ${speaker}: «${statement}» (${impactText})`);
      if (wasManuallyChecked) {
        lines.push(`   Уже проверено вручную — ${signal.sourceDescription}`);
      } else {
        toVerifyCount += 1;
        lines.push('   ТРЕБУЕТ ПРОВЕРКИ — источник ещё не подтверждён вручную.');
        if (signal.sourceDescription) {
          lines.push(`   Догадка AI о направлении поиска (не подтверждённый источник): ${signal.sourceDescription}`);
        }
      }
      lines.push('');
    });

    const header = `Список утверждений для проверки — разговор от ${new Date(conversation.occurredAt).toLocaleDateString('ru-RU')}, отсортировано по важности (всего ${sorted.length}, из них требует проверки: ${toVerifyCount})\n\n`;

    return { text: header + lines.join('\n').trimEnd(), count: sorted.length };
  }

  private async buildPriorConversationsByPerson(
    projectId: string,
    excludeConversationId: string,
    currentSegments: Array<{ participant: { personId: string | null } | null }>,
  ): Promise<Map<string, string>> {
    const personIds = [
      ...new Set(
        currentSegments
          .map((s) => s.participant?.personId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const result = new Map<string, string>();
    if (personIds.length === 0) return result;

    for (const personId of personIds) {
      const pastConversations = await this.prisma.conversation.findMany({
        where: {
          projectId,
          id: { not: excludeConversationId },
          status: { in: [ConversationProcessingStatus.TRANSCRIBED, ConversationProcessingStatus.ANALYZED] },
          participants: { some: { personId } },
        },
        include: {
          transcript: {
            include: { segments: { where: { participant: { personId } }, include: { participant: true } } },
          },
        },
        orderBy: { occurredAt: 'desc' },
        take: PRIOR_CONVERSATIONS_LIMIT,
      });

      const text = pastConversations
        .map((c: any) => {
          const segs = (c.transcript?.segments ?? []).map((s: any) => s.text).join(' ');
          return segs ? `(${c.occurredAt.toISOString().slice(0, 10)}) ${segs}` : null;
        })
        .filter(Boolean)
        .join('\n');
      if (text) result.set(personId, text);
    }
    return result;
  }

  /** Пункт 42: переименован из resolveSourceDescription() —
   * восстанавливает И описание источника, И potentialImpact из
   * AIInference.output по transcriptSegmentId, понимает ДВЕ разные
   * формы вывода:
   * (1) массив RawDiscrepancy[] от detect() — батч на весь разговор,
   *     сопоставляется по segmentId;
   * (2) один объект RawSourceCheckResult от checkAgainstUserSource() —
   *     AI-вызов на ОДИН конкретный сегмент, aiInferenceId уникален
   *     для этого сигнала, сопоставление по segmentId не нужно.
   *
   * ЧЕСТНОЕ ОГРАНИЧЕНИЕ: для формы (2) сам URL здесь НЕ восстановим —
   * AIInference.output содержит только ответ AI, не исходный параметр
   * url, переданный в вызов. Непосредственный ответ checkAgainstUserSource()
   * содержит полный текст с URL (см. return в самом методе) — эта
   * функция восстанавливает то же самое ПОЗЖЕ, из истории (list()/
   * exportFactsToVerify()), где URL уже недоступен без отдельного поля
   * на схеме. Маркерная фраза "Источник по ссылке, указанной
   * пользователем" сохранена в обоих местах одинаково —
   * exportFactsToVerify() ищет именно её, чтобы отличить "проверено
   * вручную" от "AI-догадка о направлении поиска". */
  private resolveSignalDetails(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): { sourceDescription: string | null; potentialImpact: string | null } {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed = JSON.parse(ev.aiInference.output);
        if (Array.isArray(parsed)) {
          const match = (parsed as RawDiscrepancy[]).find((p) => p.segmentId === signal.transcriptSegmentId);
          if (match) return { sourceDescription: match.sourceDescription, potentialImpact: match.potentialImpact ?? null };
          continue;
        }
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.explanation === 'string') {
          return {
            sourceDescription: `Источник по ссылке, указанной пользователем — ${parsed.explanation}`,
            potentialImpact: typeof parsed.potentialImpact === 'string' ? parsed.potentialImpact : null,
          };
        }
      } catch {
        continue;
      }
    }
    return { sourceDescription: null, potentialImpact: null };
  }

  private async findOwnedConversationWithTranscript(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        project: true,
        transcript: { include: { segments: { include: { participant: true } } } },
      },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }

  private async findOwnedSignal(userId: string, signalId: string) {
    const signal = await this.prisma.conversationSignal.findUnique({
      where: { id: signalId },
      include: { transcriptSegment: { include: { transcript: { include: { conversation: { include: { project: true } } } } } } },
    });
    const project = signal?.transcriptSegment?.transcript?.conversation?.project;
    if (!signal || !project || project.ownerId !== userId) {
      throw new NotFoundException(`ConversationSignal ${signalId} not found`);
    }
    return signal;
  }
}
