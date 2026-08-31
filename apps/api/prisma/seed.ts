// Seed для MVP-фичи 1 — минимальный набор данных, без которого
// AIRouterService не может подобрать модель (нет AIProvider/AIModel/
// AIModelVersion/AIModelCapability в пустой БД) и ArgumentGenerationService
// не может найти активный промпт (создаётся сразу в статусе ACTIVE —
// на реальном проекте новый промпт должен проходить через draft →
// testing → active с ReleaseGate, здесь для первого прохода пропущено
// осознанно, чтобы MVP можно было проверить сразу, без полного evaluation
// pipeline; отмечено, не спрятано).

import { PrismaClient, DeletionBehavior } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const openai = await prisma.aIProvider.upsert({
    where: { name: 'openai' },
    update: {},
    create: {
      name: 'openai',
      apiEndpoint: 'https://api.openai.com/v1',
      authMethod: 'bearer',
      credentialRef: 'OPENAI_API_KEY',
    },
  });

  const anthropic = await prisma.aIProvider.upsert({
    where: { name: 'anthropic' },
    update: {},
    create: {
      name: 'anthropic',
      apiEndpoint: 'https://api.anthropic.com',
      authMethod: 'x-api-key',
      credentialRef: 'ANTHROPIC_API_KEY',
    },
  });

  const xai = await prisma.aIProvider.upsert({
    where: { name: 'xai' },
    update: {},
    create: {
      name: 'xai',
      apiEndpoint: 'https://api.x.ai/v1',
      authMethod: 'bearer',
      credentialRef: 'XAI_API_KEY',
    },
  });

  // Пункт 13: STT/диаризация (Conversation Dossier, раздел 2 ТЗ) —
  // тот же реестр AIProvider/AIModel/AIModelVersion/AIModelCapability,
  // что для LLM-провайдеров выше, не отдельная параллельная структура
  // (см. обоснование выбора AssemblyAI и решение не тащить через AIJob
  // в prisma/README.md, "Пункт 13").
  const assemblyai = await prisma.aIProvider.upsert({
    where: { name: 'assemblyai' },
    update: {},
    create: {
      name: 'assemblyai',
      apiEndpoint: 'https://api.assemblyai.com/v2',
      authMethod: 'x-api-key',
      credentialRef: 'ASSEMBLYAI_API_KEY',
    },
  });

  // Пункт [multimodal] §5 — Gemini: единственный провайдер с медиа и
  // фоновыми задачами (Interactions API, background: true). Ключ — в
  // ЗАГОЛОВКЕ x-goog-api-key: живая диагностика 2026-08-31
  // (scripts/diagnose-gemini.ts) подтвердила header-auth (вариант A1),
  // query-вариант (?key=) не прошёл ни разу. authMethod здесь —
  // документальное описание; клиент использует header-auth напрямую.
  //
  // ВЕРСИЯ МОДЕЛИ: gemini-3.7-flash подтверждена тем же живым прогоном
  // (200 OK, задача принята). При смене модели — сверить со списком,
  // доступным ВАШЕМУ ключу (ТЗ §1.2).
  const google = await prisma.aIProvider.upsert({
    where: { name: 'google' },
    update: {},
    create: {
      name: 'google',
      region: 'US',
      apiEndpoint: 'https://generativelanguage.googleapis.com',
      authMethod: 'header-key',
      credentialRef: 'GEMINI_API_KEY',
    },
  });
  const googleModel = await prisma.aIModel.upsert({
    where: { providerId_name: { providerId: google.id, name: 'gemini-flash' } },
    update: {},
    create: { providerId: google.id, name: 'gemini-flash' },
  });
  const googleVersion = await prisma.aIModelVersion.upsert({
    where: { modelId_version: { modelId: googleModel.id, version: 'gemini-3.7-flash' } },
    update: {},
    create: { modelId: googleModel.id, version: 'gemini-3.7-flash' },
  });
  for (const mediaTaskType of ['media-public-review', 'conversation-paralinguistics']) {
    const existing = await prisma.aIModelCapability.findFirst({
      where: { modelVersionId: googleVersion.id, taskType: mediaTaskType },
    });
    if (!existing) {
      await prisma.aIModelCapability.create({
        data: {
          modelVersionId: googleVersion.id,
          taskType: mediaTaskType,
          structuredOutput: true,
          streaming: false,
          vision: true, // resolveModelVersion фильтрует по vision/audio для медиа-задач (§10.3)
          audio: true,
          latencyClass: 'high', // фоновая задача, минуты — потому и асинхронная полоса
          privacyClass: 'external_processing',
          costClass: 'high', // ~300 токенов/сек видео — на два порядка дороже текстовых вызовов
          availability: 'active',
        },
      });
    }
  }

  const openaiModel = await prisma.aIModel.upsert({
    where: { providerId_name: { providerId: openai.id, name: 'gpt-4.1' } },
    update: {},
    create: { providerId: openai.id, name: 'gpt-4.1' },
  });
  const anthropicModel = await prisma.aIModel.upsert({
    where: { providerId_name: { providerId: anthropic.id, name: 'claude-sonnet-5' } },
    update: {},
    create: { providerId: anthropic.id, name: 'claude-sonnet-5' },
  });
  const xaiModel = await prisma.aIModel.upsert({
    // Полный аудит периметров 2026-08-30 (по прямому запросу — сверка
    // с рабочей реализацией в silverfinance): grok-4 официально снят
    // xAI с производства 15 мая 2026 (вся линейка grok-4-*/grok-3
    // отправляется на редирект). Запросы к retired-слагам всё ещё
    // формально проходят (xAI редиректит их на grok-4.3), но: (1)
    // тарифицируются по цене grok-4.3 независимо от ожиданий проекта,
    // (2) reasoning effort молча становится "low"/"none" через
    // редирект, не выбирается явно, (3) сама xAI прямо советует «для
    // новых конфигураций используйте актуальный canonical model ID
    // напрямую», не полагаться на редирект как постоянное решение.
    // grok-4.3 — тот же слаг, что silverfinance подтвердил рабочим в
    // production после того, как более старый grok-2-vision-1212 стал
    // возвращать HTTP 400 "model not available" — не самый новый
    // флагман xAI на сегодня (Grok 4.6 вышел 12 августа 2026), но
    // осознанно взят подтверждённый рабочий слаг, не самый свежий
    // неподтверждённый.
    where: { providerId_name: { providerId: xai.id, name: 'grok-4.3' } },
    update: {},
    create: { providerId: xai.id, name: 'grok-4.3' },
  });

  const openaiVersion = await prisma.aIModelVersion.upsert({
    where: { modelId_version: { modelId: openaiModel.id, version: 'gpt-4.1' } },
    update: {},
    create: { modelId: openaiModel.id, version: 'gpt-4.1' },
  });
  const anthropicVersion = await prisma.aIModelVersion.upsert({
    where: { modelId_version: { modelId: anthropicModel.id, version: 'claude-sonnet-5' } },
    update: {},
    create: { modelId: anthropicModel.id, version: 'claude-sonnet-5' },
  });
  const xaiVersion = await prisma.aIModelVersion.upsert({
    where: { modelId_version: { modelId: xaiModel.id, version: 'grok-4.3' } },
    update: {},
    create: { modelId: xaiModel.id, version: 'grok-4.3' },
  });

  // Пункт 13: AssemblyAI "best" tier — комбинированные STT+диаризация
  // в одном вызове (см. обоснование выбора провайдера в README).
  const assemblyaiModel = await prisma.aIModel.upsert({
    where: { providerId_name: { providerId: assemblyai.id, name: 'best' } },
    update: {},
    create: { providerId: assemblyai.id, name: 'best' },
  });
  const assemblyaiVersion = await prisma.aIModelVersion.upsert({
    where: { modelId_version: { modelId: assemblyaiModel.id, version: 'best' } },
    update: {},
    create: { modelId: assemblyaiModel.id, version: 'best' },
  });
  const existingAssemblyCapability = await prisma.aIModelCapability.findFirst({
    where: { modelVersionId: assemblyaiVersion.id, taskType: 'audio_transcription' },
  });
  if (!existingAssemblyCapability) {
    await prisma.aIModelCapability.create({
      data: {
        modelVersionId: assemblyaiVersion.id,
        taskType: 'audio_transcription',
        structuredOutput: true, // JSON-ответ с сегментами/спикерами, не свободный текст
        streaming: false,
        audio: true,
        latencyClass: 'medium', // async job, не realtime — минуты на часовой файл, не секунды
        privacyClass: 'ephemeral_processing', // файл не хранится у AssemblyAI дольше обработки при соответствующей настройке аккаунта — см. README про EPHEMERAL_SERVER
        costClass: 'low',
        availability: 'active',
      },
    });
  }

  // Фичи 7 (Steelman) и 10 (скрипты открытия/закрытия) добавили ещё
  // два taskType — тот же паттерн capability на все три провайдера.
  // Пункт 21 (Source Conflict Resolver, §3.56 ТЗ) добавил ещё один
  // taskType поверх LLM-провайдеров — тот же паттерн, что и семь
  // предыдущих.
  // Пункт 25 (Prediction vs Reality, §3.60 ТЗ) добавил ещё один
  // taskType поверх LLM-провайдеров — тот же паттерн, что и восемь
  // предыдущих.
  // Пункт 27 (Conversation Agenda, раздел 2 ТЗ) добавил ещё один
  // taskType поверх LLM-провайдеров — тот же паттерн, что и девять
  // предыдущих.
  // Пункт 36 (Manipulation Detector, §3.28 ТЗ, MVP v3) добавил ещё
  // один taskType поверх LLM-провайдеров — тот же паттерн, что и все
  // предыдущие AI-фичи.
  // Пункт 37 (Discrepancy Analysis, §3.16 ТЗ, MVP v3) добавил ещё один
  // taskType поверх LLM-провайдеров — тот же паттерн, что и все
  // предыдущие AI-фичи.
  // Пункт 38 (Archetype Perspective, §3.11 ТЗ, MVP v3) добавил ещё
  // один taskType поверх LLM-провайдеров — тот же паттерн, что и все
  // предыдущие AI-фичи.
  // Пункт 39 (Communication Profile, §3.11 ТЗ текст, роадмап-пункт 24
  // v3) добавил ещё один taskType поверх LLM-провайдеров — тот же
  // паттерн, что и все предыдущие AI-фичи.
  // Пункт 40 (Discrepancy Source Check, §3.16 ТЗ четвёртый источник)
  // добавил ещё один taskType поверх LLM-провайдеров — тот же
  // паттерн, что и все предыдущие AI-фичи.
  // Пункт 44 (Stakeholder Map, §3.8 ТЗ) добавил два taskType поверх
  // LLM-провайдеров — тот же паттерн, что и все предыдущие AI-фичи.
  // Пункт 45 (Precedent Search, §3.9 ТЗ — только половина: личные
  // записи, без публичного поиска) добавил ещё один taskType поверх
  // LLM-провайдеров.
  // Пункт 47 (Outcome Forecasting, §3.12 ТЗ) добавил ещё один
  // taskType поверх LLM-провайдеров — тот же паттерн, что и все
  // предыдущие AI-фичи.
  // Пункт 49 (Reconciliation Arguments §3.14 ТЗ + Onboarding
  // Religion Suggestion) добавил два taskType поверх LLM-провайдеров.
  // Пункт 55 (Sparring/Red Team, §3.1 ТЗ) добавил ещё один taskType
  // поверх LLM-провайдеров.
  // Пункт 59 (Motive Analysis, §3.18 ТЗ — только личные данные,
  // публичный поиск сознательно не реализован) добавил ещё один
  // taskType поверх LLM-провайдеров.
  // Пункт 60 (Working Materials, §3.27 ТЗ — только текстовые
  // материалы, реализовано в честно суженном объёме) добавил ещё
  // один taskType поверх LLM-провайдеров.
  // Пункт 62 (Protocol, §3.30 ТЗ) добавил ещё один taskType поверх
  // LLM-провайдеров.
  // Пункт 64 (§3.24 частично + §3.25 ТЗ) добавил ещё два taskType
  // поверх LLM-провайдеров.
  // Пункт 65 (§3.22 ТЗ, честно суженный объём) добавил ещё один
  // taskType поверх LLM-провайдеров.
  // Пункт 70 (§3.41 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 72 (§3.35 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 76 (§3.21 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 79 (пункт 58 общего списка) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 82 (§3.4 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 83 (§3.33 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 84 (§3.33 ТЗ) добавил два taskType поверх LLM-провайдеров.
  // Пункт 86 (§3.37 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  // Пункт 91 (§3.27 ТЗ) добавил ещё один taskType поверх LLM-провайдеров.
  const taskTypes = ['argument-generation', 'steelman', 'conversation-script', 'turning-point-detection', 'missing-information-detection', 'do-not-say-detection', 'best-next-move-detection', 'source-conflict-detection', 'prediction-analysis', 'conversation-agenda-generation', 'manipulation-detection', 'discrepancy-analysis', 'archetype-perspective', 'communication-profile', 'discrepancy-source-check', 'stakeholder-role-suggestion', 'stakeholder-argument-generation', 'precedent-search', 'outcome-forecasting', 'reconciliation-arguments', 'onboarding-religion-suggestion', 'sparring-session', 'motive-analysis', 'working-material-critique', 'protocol-generation', 'situational-quote', 'situational-anecdote', 'venue-suitability', 'compromise-sheet', 'closing-message', 'weather-recommendation', 'scheduler-advice', 'live-hint', 'live-manipulation-detection', 'breaking-questions', 'live-argument-tracking', 'probing-detection', 'material-chat'];

  for (const modelVersionId of [openaiVersion.id, anthropicVersion.id, xaiVersion.id]) {
    for (const taskType of taskTypes) {
      const existingCapability = await prisma.aIModelCapability.findFirst({
        where: { modelVersionId, taskType },
      });
      if (!existingCapability) {
        await prisma.aIModelCapability.create({
          data: {
            modelVersionId,
            taskType,
            structuredOutput: true,
            streaming: false,
            maxContext: 128000,
            latencyClass: 'medium',
            costClass: 'medium',
            availability: 'active',
          },
        });
      }
    }
  }

  const existingPrompt = await prisma.promptVersion.findFirst({
    where: { promptId: 'argument-generation', version: 'v1' },
  });
  if (!existingPrompt) {
    await prisma.promptVersion.create({
      data: {
        promptId: 'argument-generation',
        version: 'v1',
        template:
          'Ты помогаешь человеку подготовиться к разговору. Сгенерируй список аргументов за и против по описанной ситуации. Ответь СТРОГО валидным JSON-массивом объектов вида {"text": string, "stance": "pro"|"con", "weight": number от 0 до 1}. Без пояснений вне JSON.',
        status: 'ACTIVE', // см. комментарий в шапке файла про пропуск evaluation gate для первого прохода
      },
    });
  }

  console.log('Seed complete: 4 providers, 4 models, capabilities, 1 active prompt.');

  // TTL-настройки (§4.7 ТЗ) — маппинг класса на реально существующие
  // таблицы задокументирован здесь текстом (не FK, см. комментарий в
  // schema.prisma над RetentionClass) — это единственное место, где
  // этот маппинг зафиксирован, важно не потерять его при дальнейшей
  // работе над enforcement.
  //
  // Явная типизация массива (не let TS выводит string для
  // deletionBehavior) — при первой версии здесь была затычка `as any`
  // на месте prisma.retentionClass.create(), найденная и исправленная
  // при аудите: без явного типа TS видел `deletionBehavior: string`,
  // не enum DeletionBehavior, и create() не собирался бы типами.
  // Правильное исправление — типизировать данные, не глушить ошибку
  // типа приведением к any.
  interface RetentionClassSeed {
    classKey: string;
    displayName: string;
    description: string;
    defaultRetentionDays: number | null;
    userOverrideAllowed: boolean;
    legalHold: boolean;
    deletionBehavior: DeletionBehavior;
  }

  const retentionClasses: RetentionClassSeed[] = [
    {
      classKey: 'RAW_LOCAL',
      displayName: 'Сырые записи разговоров',
      description:
        'Аудио/видео/фото разговоров — не хранятся на сервере вообще (раздел 2 ТЗ), только на устройстве пользователя. Эта строка — декларация архитектурного принципа, не описание серверной таблицы с TTL, потому что такой таблицы не существует.',
      defaultRetentionDays: null, // не применимо — сервер физически не хранит эти данные
      userOverrideAllowed: false,
      legalHold: false,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'DERIVED_PRIVATE',
      displayName: 'Личные данные (факты, аргументы, Steelman-кейсы, скрипты)',
      description:
        'PersonFact, Argument, SteelmanCase, ConversationScript, DecisionObjective, NegotiationBoundaries — основные данные продукта. Хранятся, пока пользователь не удалит проект/персону вручную (Privacy Center, фича 11) — не по TTL-таймеру.',
      defaultRetentionDays: null,
      userOverrideAllowed: false,
      legalHold: false,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'AI_INFERENCE',
      displayName: 'AI-выводы',
      description:
        'AIInference — сырой вывод модели, на основе которого строятся Argument/SteelmanCase/ConversationScript. Каскадно удаляется при удалении связанной сущности (см. деталь про source_unavailable в prisma/README.md, пункт 2-3 чекпоинта).',
      defaultRetentionDays: null,
      userOverrideAllowed: false,
      legalHold: false,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'PUBLIC_CONTENT',
      displayName: 'Публично опубликованный контент',
      description:
        'Публичное обсуждение по ссылке (§4.5 ТЗ) — не реализовано в MVP v1 вообще, строка здесь для полноты справочника, не описывает существующую функциональность.',
      defaultRetentionDays: null,
      userOverrideAllowed: false,
      legalHold: false,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'AUDIT_LOG',
      displayName: 'Журнал безопасности (append-only)',
      description:
        'AuditLogEntry — технический журнал действий (не путать с ProjectLogEntry, который видит пользователь). Хранится дольше остальных для разбора инцидентов — 365 дней по умолчанию, без права пользователя сократить срок.',
      defaultRetentionDays: 365,
      userOverrideAllowed: false,
      legalHold: true,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'CONSENT_LOG',
      displayName: 'История согласий',
      description:
        'ConsentRecord — история выданных/отозванных согласий. Хранится бессрочно даже после отзыва (сам факт отзыва — юридически значимая запись), не путать с "согласие действует" — то проверяется по revokedAt, не по наличию записи.',
      defaultRetentionDays: null,
      userOverrideAllowed: false,
      legalHold: true,
      deletionBehavior: 'HARD_DELETE',
    },
    {
      classKey: 'SHARE_LOG',
      displayName: 'Журнал Safe Share',
      description:
        'SafeShareAction — что и когда пользователь отправил вовне через Safe Share (фича 12). 180 дней по умолчанию, пользователь может запросить более раннее удаление через Privacy Center (userOverrideAllowed — хотя сама возможность override пока не реализована в UI, только продекларирована здесь).',
      defaultRetentionDays: 180,
      userOverrideAllowed: true,
      legalHold: false,
      deletionBehavior: 'HARD_DELETE',
    },
  ];

  for (const rc of retentionClasses) {
    const existing = await prisma.retentionClass.findUnique({ where: { classKey: rc.classKey } });
    if (!existing) {
      await prisma.retentionClass.create({ data: rc });
    }
  }

  console.log(`Seed complete: ${retentionClasses.length} retention classes.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
