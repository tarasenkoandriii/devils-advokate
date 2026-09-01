// Пункт [admin-sandbox] 2026-08-31 — песочница оператора: прогон
// реальных сценариев (в первую очередь цепочки YouTube-разбора) из
// админки, против боевой конфигурации.
//
// ЗАЧЕМ ОНА, если есть TMA. Продовый API закрыт Telegram-авторизацией:
// каждый запрос требует подписанной initData, curl'ом его не потрогать,
// а `ALLOW_DEV_AUTH=true` в проде — дыра, а не инструмент. В итоге
// единственным способом проверить «собралась ли цепочка» был клик по
// настоящему TMA с телефона — медленно, без диагностики, и падает оно
// там с сообщением для пользователя, а не для оператора. Песочница
// делает то же самое из админки: тот же код, те же сервисы, тот же
// пользователь — но с внятным отчётом на каждом шаге.
//
// ТРИ ПРИНЦИПА, каждый — граница безопасности:
//
// 1. Всё выполняется ОТ ИМЕНИ САМОГО ОПЕРАТОРА (userId из админ-сессии),
//    никакой имперсонации. Оператор не может через песочницу читать
//    чужие разговоры или расходовать чужие лимиты — только свои.
//    Согласия тоже свои: кнопка «выдать согласия» выдаёт их
//    операторскому аккаунту, тем же ConsentService.grant(), которым
//    пользуется TMA, с source='admin-sandbox' в юридическом следе.
//
// 2. Никаких обходов проверок. Прогон транскрибации идёт через
//    ConversationsService.streamUploadAudio()/requestTranscription() —
//    со всеми проверками согласий и режима приватности. Если проверка
//    останавливает прогон, это не сбой песочницы, это ЕЁ РЕЗУЛЬТАТ:
//    значит, и у пользователя остановит.
//
// 3. Диагностика конфигурации НЕ показывает значений секретов — только
//    задан/не задан и коды проблем. Единственное значение, которое
//    выводится целиком, — API_PUBLIC_BASE_URL: это публичный адрес по
//    определению, и именно его «почти правильные» значения (домен
//    админки вместо API, слэш на конце) стоили больше всего времени на
//    реальном деплое.

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { HandleUploadBody } from '@vercel/blob/client';
import { ConsentType, ConversationSourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ConversationsService } from '../conversations/conversations.service';
import { AudioBlobService } from '../conversations/audio-blob.service';
import { YouTubeSearchService } from '../media-review/youtube-search.service';
import { MediaReviewService } from '../media-review/media-review.service';
import { MediaReviewAutoService } from '../media-review/media-review-auto.service';
import { AIRouterService } from '../ai-router/ai-router.service';
import { ManipulationDetectorService } from '../manipulation-detector/manipulation-detector.service';
import { DiscrepancyAnalysisService } from '../discrepancy-analysis/discrepancy-analysis.service';
import { TurningPointsService } from '../turning-points/turning-points.service';
import { publicApiBaseUrl } from '../common/public-base-url';
import { resolveBlobToken } from '../common/blob-token';
import { diagnoseDatabaseUrl, diagnosePoolerMismatch } from '../prisma/database-url-check';

/** Вопрос-маркер песочного проекта. Поиск идёт по нему, поэтому прогоны
 * переиспользуют один проект, а не плодят новый на каждую кнопку. */
const SANDBOX_PROJECT_QUESTION = '[SANDBOX] Проверка конвейера из админки';

/** Название песочной очереди медиа-разбора — та же логика
 * переиспользования по маркеру, что у проекта выше. */
const SANDBOX_QUEUE_TITLE = '[SANDBOX] Очередь из админки';

const SANDBOX_CONSENT_TYPES: ConsentType[] = [
  ConsentType.RECORDING,
  ConsentType.EPHEMERAL_SERVER,
  ConsentType.EXTERNAL_AI,
];

export interface SandboxCheckItem {
  key: string;
  label: string;
  ok: boolean;
  /** Пояснение ТОЛЬКО без секретов: коды, счётчики, публичные адреса. */
  detail?: string;
}

export type SandboxAnalysisKind = 'manipulation' | 'discrepancy' | 'turning-points';

/** 3 секунды моно 8кГц 16-бит — ~47 КБ. Синус 440 Гц с огибающей,
 * чтобы файл не был строго периодическим (некоторые кодеки/валидаторы
 * подозрительны к идеальной тишине и идеальному тону). Речи здесь нет,
 * и транскрипт ожидаемо будет ПУСТЫМ — прогон проверяет конвейер
 * (загрузка → job → вебхук → статус), а не качество распознавания. */
export function makeSandboxWav(): Buffer {
  const sampleRate = 8000;
  const seconds = 3;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // размер fmt-чанка
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // моно
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // бит на сэмпл
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin((Math.PI * i) / samples); // плавный вход/выход
    const value = Math.round(Math.sin(2 * Math.PI * 440 * t) * envelope * 12000);
    buf.writeInt16LE(value, 44 + i * 2);
  }
  return buf;
}

@Injectable()
export class AdminSandboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
    private readonly conversations: ConversationsService,
    private readonly audioBlob: AudioBlobService,
    private readonly youtube: YouTubeSearchService,
    private readonly mediaReview: MediaReviewService,
    private readonly mediaReviewAuto: MediaReviewAutoService,
    private readonly aiRouter: AIRouterService,
    private readonly manipulation: ManipulationDetectorService,
    private readonly discrepancy: DiscrepancyAnalysisService,
    private readonly turningPoints: TurningPointsService,
  ) {}

  /** Песочница — операторский инструмент: она расходует реальные
   * деньги (AssemblyAI, LLM) и реальную квоту YouTube, поэтому та же
   * граница, что у остальных операционных вкладок (§4.1 admin-panel-tz),
   * а не у модераторских. */
  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  private async secretPresent(ref: string): Promise<boolean> {
    try {
      await this.secrets.resolve(ref);
      return true;
    } catch {
      return false;
    }
  }

  /** Чек-лист готовности цепочки YouTube-разбора. Каждый пункт — то,
   * что на реальном деплое 2026-08-31 УЖЕ ломалось или могло сломаться
   * молча; порядок — порядок шагов цепочки, а не важности. */
  async getStatus(operatorUserId: string): Promise<{ items: SandboxCheckItem[] }> {
    await this.assertOperator(operatorUserId);
    const items: SandboxCheckItem[] = [];

    // 1. База — без неё бессмысленно всё остальное.
    const dbProblems = diagnoseDatabaseUrl(process.env.DATABASE_URL);
    const poolerWarning = diagnosePoolerMismatch(process.env.DATABASE_URL);
    let dbReachable = false;
    let userCount = 0;
    try {
      userCount = await this.prisma.user.count();
      dbReachable = true;
    } catch {
      /* отражено в items ниже */
    }
    items.push({
      key: 'database',
      label: 'База данных',
      ok: dbReachable && dbProblems.length === 0,
      detail: dbReachable
        ? [`подключение работает, пользователей: ${userCount}`, poolerWarning].filter(Boolean).join('; ')
        : dbProblems.length > 0
          ? `DATABASE_URL: ${dbProblems.map((p) => p.code).join(', ')}`
          : 'подключение не удалось — см. Runtime Logs',
    });

    // 2. Сид — без записей AIProvider резолвить credentialRef нечего.
    let providers = 0;
    let assemblyaiSeeded = false;
    if (dbReachable) {
      providers = await this.prisma.aIProvider.count();
      assemblyaiSeeded = (await this.prisma.aIProvider.findUnique({ where: { name: 'assemblyai' } })) !== null;
    }
    items.push({
      key: 'seed',
      label: 'Сид БД (AIProvider/модели)',
      ok: providers > 0 && assemblyaiSeeded,
      detail:
        providers === 0
          ? 'провайдеров нет — выполните npm run prisma:seed'
          : assemblyaiSeeded
            ? `провайдеров: ${providers}`
            : `провайдеров: ${providers}, но записи assemblyai нет`,
    });

    // 3. Ключи по шагам цепочки. Только задан/не задан — значения
    // секретов из этого эндпоинта не выходят никогда.
    items.push({
      key: 'youtube',
      label: 'YOUTUBE_API_KEY (шаг 1: поиск)',
      ok: await this.secretPresent('YOUTUBE_API_KEY'),
    });
    items.push({
      key: 'assemblyai',
      label: 'ASSEMBLYAI_API_KEY (шаги 5–7: расшифровка)',
      ok: await this.secretPresent('ASSEMBLYAI_API_KEY'),
    });
    items.push({
      key: 'webhook-secret',
      label: 'ASSEMBLYAI_WEBHOOK_SECRET (шаг 7: приём результата)',
      ok: await this.secretPresent('ASSEMBLYAI_WEBHOOK_SECRET'),
    });

    // 4. Публичный адрес API — единственное значение, которое
    // показывается целиком: оно публичное по определению, а «почти
    // правильные» варианты (домен админки, слэш) неотличимы без него.
    try {
      const base = publicApiBaseUrl();
      items.push({ key: 'base-url', label: 'API_PUBLIC_BASE_URL', ok: true, detail: base });
    } catch (err) {
      items.push({
        key: 'base-url',
        label: 'API_PUBLIC_BASE_URL',
        ok: false,
        detail: err instanceof Error ? err.message : 'не задан',
      });
    }

    // 5. Blob-токен — под любым из двух имён (см. common/blob-token.ts).
    let blobOk = true;
    try {
      await resolveBlobToken(this.secrets);
    } catch {
      blobOk = false;
    }
    items.push({
      key: 'blob',
      label: 'Токен Vercel Blob (прямая загрузка файлов)',
      ok: blobOk,
      detail: blobOk ? undefined : 'нет ни VERCEL_BLOB_READ_WRITE_TOKEN, ни BLOB_READ_WRITE_TOKEN',
    });

    // 5b. Пункт [multimodal] — мультимодальный анализ (авто-разбор
    // YouTube + паралингвистика): ключ Gemini и секрет воркера
    // асинхронной полосы (pg_cron_ai_jobs.sql).
    items.push({
      key: 'gemini',
      label: 'GEMINI_API_KEY (мультимодальный анализ видео/аудио)',
      ok: await this.secretPresent('GEMINI_API_KEY'),
    });
    items.push({
      key: 'ai-dispatch',
      label: 'AI_JOB_DISPATCH_SECRET (воркер асинхронных AI-задач)',
      ok: await this.secretPresent('AI_JOB_DISPATCH_SECRET'),
      detail: (await this.secretPresent('AI_JOB_DISPATCH_SECRET'))
        ? undefined
        : 'без него pg_cron-джобы ai-jobs-* не пройдут аутентификацию — см. prisma/manual-migrations/pg_cron_ai_jobs.sql',
    });

    // 6. LLM-ключи (шаг 8: анализ) — нужен хотя бы один.
    const llm = {
      openai: await this.secretPresent('OPENAI_API_KEY'),
      anthropic: await this.secretPresent('ANTHROPIC_API_KEY'),
      xai: await this.secretPresent('XAI_API_KEY'),
    };
    const llmAny = llm.openai || llm.anthropic || llm.xai;
    items.push({
      key: 'llm',
      label: 'LLM-ключ (шаг 8: анализ)',
      ok: llmAny,
      detail: llmAny
        ? Object.entries(llm)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ')
        : 'ни одного из OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY',
    });

    // 7. CORS — не про цепочку, но про то, увидит ли её фронтенд.
    const cors = process.env.CORS_ORIGIN?.trim();
    items.push({
      key: 'cors',
      label: 'CORS_ORIGIN',
      ok: Boolean(cors),
      detail: cors || 'не задан — в проде это блокирует все cross-origin запросы (fail closed)',
    });

    // 8. Согласия и режим приватности САМОГО оператора: прогоны идут
    // от его имени, и без согласий транскрибация честно откажет.
    if (dbReachable) {
      const user = await this.prisma.user.findUnique({
        where: { id: operatorUserId },
        select: { privacyProcessingMode: true },
      });
      const consents: string[] = [];
      const missing: string[] = [];
      for (const type of SANDBOX_CONSENT_TYPES) {
        (await this.consent.hasActiveConsent(operatorUserId, type)) ? consents.push(type) : missing.push(type);
      }
      const modeOk = user?.privacyProcessingMode !== 'MAXIMUM_PRIVACY';
      items.push({
        key: 'consents',
        label: 'Согласия вашего аккаунта (для прогона транскрибации)',
        ok: missing.length === 0 && modeOk,
        detail: !modeOk
          ? 'privacyProcessingMode=MAXIMUM_PRIVACY — облачная расшифровка запрещена, согласиями не обходится'
          : missing.length > 0
            ? `не хватает: ${missing.join(', ')} — кнопка «Выдать согласия» ниже`
            : consents.join(', '),
      });
    }

    return { items };
  }

  /** Согласия — СЕБЕ, тем же путём, что TMA. source='admin-sandbox'
   * остаётся в юридическом следе: видно, что согласие выдано из
   * песочницы, а не через пользовательский экран согласий. */
  async grantOwnConsents(operatorUserId: string) {
    await this.assertOperator(operatorUserId);
    const granted: string[] = [];
    for (const type of SANDBOX_CONSENT_TYPES) {
      if (!(await this.consent.hasActiveConsent(operatorUserId, type))) {
        await this.consent.grant({
          userId: operatorUserId,
          consentType: type,
          version: '1.0',
          source: 'admin-sandbox',
        });
        granted.push(type);
      }
    }
    return { granted, alreadyHad: SANDBOX_CONSENT_TYPES.filter((t) => !granted.includes(t)) };
  }

  /** Шаг 1 цепочки: реальный поиск через YouTubeSearchService — с
   * реальной квотой Google и реальным лимитом 20/сутки, которые
   * расходуются с аккаунта оператора. Песочница намеренно НЕ обходит
   * лимит: «у оператора работает, у пользователей кончилась квота» —
   * ровно тот класс расхождений, который она должна ловить, а не
   * создавать. */
  async youtubeSearch(operatorUserId: string, query: string) {
    await this.assertOperator(operatorUserId);
    if (!query?.trim()) {
      throw new BadRequestException('Пустой запрос');
    }
    const startedAt = Date.now();
    const results = await this.youtube.search(operatorUserId, query.trim());
    return { tookMs: Date.now() - startedAt, results };
  }

  /** Шаги 4–6 цепочки одним прогоном: проект → разговор → загрузка
   * сгенерированного WAV → постановка задачи на расшифровку. Дальше
   * работает вебхук; его результат смотрят через getConversation().
   *
   * Файл синтетический (3 сек тона, ~47 КБ) — see makeSandboxWav().
   * Это осознанный компромисс: прогон проверяет ИНФРАСТРУКТУРУ
   * (ключ, загрузку, webhook-адрес, секрет вебхука, запись статусов),
   * а не качество распознавания, и стоит копейки. Транскрипт будет
   * пустым — это ожидаемо и написано в UI. */
  async runTranscriptionSmoke(operatorUserId: string) {
    await this.assertOperator(operatorUserId);

    let project = await this.prisma.project.findFirst({
      where: { ownerId: operatorUserId, question: SANDBOX_PROJECT_QUESTION },
    });
    if (!project) {
      project = await this.prisma.project.create({
        data: {
          ownerId: operatorUserId,
          question: SANDBOX_PROJECT_QUESTION,
          goal: 'Технический проект песочницы админки — можно удалять',
        },
      });
    }

    const conversation = await this.conversations.create(operatorUserId, project.id, {
      sourceType: ConversationSourceType.UPLOADED_AUDIO,
      occurredAt: new Date().toISOString(),
      durationSeconds: 3,
    } as never);

    // Загрузка и постановка задачи — через те же методы сервиса, что
    // использует TMA, со всеми проверками согласий/приватности внутри.
    const wav = makeSandboxWav();
    const { Readable } = await import('node:stream');
    const stream = Readable.toWeb(Readable.from(wav)) as unknown as ReadableStream<Uint8Array>;
    const { audioUrl } = await this.conversations.streamUploadAudio(operatorUserId, conversation.id, stream);

    const updated = await this.conversations.requestTranscription(operatorUserId, conversation.id, { audioUrl });

    return {
      projectId: project.id,
      conversationId: conversation.id,
      status: updated.status,
      externalJobId: updated.externalTranscriptionJobId,
      note: 'Файл — синтетический тон: транскрипт ожидаемо будет пустым. Прогон проверяет конвейер, не распознавание.',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Пункт [admin-sandbox], вторая итерация 2026-08-31 — загрузка
  // РЕАЛЬНОГО аудио/видео из песочницы, а не только синтетического WAV.
  //
  // Повод буквальный: первый же прогон на проде дошёл до TRANSCRIBED с
  // нулём сегментов (что и обещано), а следующий шаг — «загрузите
  // реальный разговор через TMA с телефона» — разрывал отладочный цикл
  // на полпути. Теперь весь цикл, включая содержательный анализ,
  // проходится из одной вкладки.
  //
  // Механика ровно та же, что у TMA (пункт [blob-upload]): токен →
  // прямая загрузка в приватный blob мимо функции → подтверждение →
  // transcribe без audioUrl. Отличие одно: у админки авторизация — не
  // Telegram-заголовок, а httpOnly-cookie, и клиентская половина
  // @vercel/blob не умеет слать cookie на кросс-доменный handleUploadUrl.
  // Поэтому админка получает клиентский токен через ОБЫЧНЫЙ
  // admin-эндпоинт (наш конверт, наши credentials) и грузит файл
  // функцией put() с этим токеном — SDK-протокол handleUpload здесь
  // синтезируется на сервере, см. issueUploadClientToken().
  // ─────────────────────────────────────────────────────────────────

  /** Разговор под загрузку реального файла — в том же песочном
   * проекте, что и синтетические прогоны. sourceType от типа файла:
   * это видно потом в TMA и влияет только на подпись, не на конвейер. */
  async createUploadConversation(operatorUserId: string, isVideo: boolean, durationSeconds?: number) {
    await this.assertOperator(operatorUserId);

    let project = await this.prisma.project.findFirst({
      where: { ownerId: operatorUserId, question: SANDBOX_PROJECT_QUESTION },
    });
    if (!project) {
      project = await this.prisma.project.create({
        data: {
          ownerId: operatorUserId,
          question: SANDBOX_PROJECT_QUESTION,
          goal: 'Технический проект песочницы админки — можно удалять',
        },
      });
    }

    const conversation = await this.conversations.create(operatorUserId, project.id, {
      sourceType: isVideo ? ConversationSourceType.UPLOADED_VIDEO : ConversationSourceType.UPLOADED_AUDIO,
      occurredAt: new Date().toISOString(),
      durationSeconds,
    } as never);

    return { projectId: project.id, conversationId: conversation.id };
  }

  /** Клиентский токен на прямую запись в blob. Тело протокола
   * handleUpload синтезируется здесь, на сервере, — клиент присылает
   * только pathname. Все ограничения (владение, согласия, префикс,
   * типы, 500 МБ, TTL) применяет AudioBlobService — тот же код, что
   * для TMA, ни одной собственной проверки-копии. */
  async issueUploadClientToken(operatorUserId: string, conversationId: string, pathname: string) {
    await this.assertOperator(operatorUserId);
    if (!pathname?.trim()) {
      throw new BadRequestException('pathname обязателен');
    }

    const body: HandleUploadBody = {
      type: 'blob.generate-client-token',
      payload: { pathname: pathname.trim(), clientPayload: null, multipart: true },
    };
    const result = await this.audioBlob.issueUploadToken(operatorUserId, conversationId, body, {});
    if (!('clientToken' in result)) {
      // По построению body недостижимо; проверка — чтобы тип ответа
      // был честным, а не «as any».
      throw new BadRequestException('Не удалось выдать токен загрузки');
    }
    return { clientToken: result.clientToken };
  }

  /** Подтверждение — тот же confirmUpload, что дергает TMA. */
  async confirmUpload(operatorUserId: string, conversationId: string, pathname: string) {
    await this.assertOperator(operatorUserId);
    return this.audioBlob.confirmUpload(operatorUserId, conversationId, { pathname });
  }

  /** Запуск расшифровки загруженного файла — transcribe без audioUrl:
   * ссылку подпишет сам ConversationsService из audioBlobPathname. */
  async transcribeUploaded(operatorUserId: string, conversationId: string, languageCode?: string) {
    await this.assertOperator(operatorUserId);
    const updated = await this.conversations.requestTranscription(operatorUserId, conversationId, { languageCode });
    return {
      conversationId,
      status: updated.status,
      externalJobId: updated.externalTranscriptionJobId,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Пункт [admin-sandbox], третья итерация 2026-08-31 — очередь
  // медиа-разбора: кнопка «Разобрать» у результата поиска.
  //
  // ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ: скачивания ролика с YouTube. Это
  // граница ТЗ медіа-разбора §2.2 (легальный путь — только метаданные
  // официального API), и песочница ей подчиняется так же, как прод:
  // кнопка связывает ролик с элементом очереди, а ФАЙЛ приносит сам
  // оператор — тем же протоколом прямой загрузки, что и выше. Зато
  // этим закрывается последний непроверенный кусок цепочки: шаг 2
  // (очередь) и синхронизация статусов READY→PROCESSING→DONE.
  // ─────────────────────────────────────────────────────────────────

  private async ensureSandboxQueue(operatorUserId: string) {
    const queues = await this.mediaReview.listQueues(operatorUserId);
    const existing = queues.find((q) => q.title === SANDBOX_QUEUE_TITLE);
    if (existing) return existing;
    return this.mediaReview.createQueue(operatorUserId, SANDBOX_QUEUE_TITLE);
  }

  /** Ролик из поиска → элемент песочной очереди. Метаданные приходят
   * от клиента, но это НЕ доверие клиенту в опасном месте: это ровно
   * тот же контракт, что у продового POST /media-review/queues/:id/items
   * — очередь и есть список присланных клиентом метаданных. */
  async addToQueue(
    operatorUserId: string,
    input: {
      youtubeVideoId: string;
      title: string;
      channelName: string;
      thumbnailUrl: string;
      durationSeconds?: number;
      publishedAt?: string;
    },
  ) {
    await this.assertOperator(operatorUserId);
    if (!input?.youtubeVideoId?.trim()) {
      throw new BadRequestException('youtubeVideoId обязателен');
    }
    const queue = await this.ensureSandboxQueue(operatorUserId);
    const item = await this.mediaReview.addItem(operatorUserId, queue.id, {
      youtubeVideoId: input.youtubeVideoId,
      title: input.title ?? '',
      channelName: input.channelName ?? '',
      thumbnailUrl: input.thumbnailUrl ?? '',
      durationSeconds: input.durationSeconds,
      publishedAt: input.publishedAt,
    });
    return { queueId: queue.id, itemId: item.id };
  }

  /** Привязка загруженного разговора к элементу очереди — продовый
   * MediaReviewService.linkConversation, элемент переходит в READY. */
  async linkQueueItem(operatorUserId: string, itemId: string, conversationId: string) {
    await this.assertOperator(operatorUserId);
    return this.mediaReview.linkConversation(operatorUserId, itemId, conversationId);
  }

  /** Песочная очередь целиком — продовый getQueue(), который заодно
   * синхронизирует статусы элементов с реальными Conversation.status
   * (READY→PROCESSING→DONE). Именно этот вызов показывает, что DONE
   * ставится только после turning-points. */
  async getSandboxQueue(operatorUserId: string) {
    await this.assertOperator(operatorUserId);
    const queues = await this.mediaReview.listQueues(operatorUserId);
    const queue = queues.find((q) => q.title === SANDBOX_QUEUE_TITLE);
    if (!queue) return { queue: null };
    const full = await this.mediaReview.getQueue(operatorUserId, queue.id);
    const items = await Promise.all(
      (full.items as Array<Record<string, unknown>>).map(async (i) => {
        // Итог разбора прямо в таблице: сигналов может честно не быть
        // (промпт запрещает выдумывать их ради количества), и без
        // счётчика сегментов DONE выглядит как «ничего не произошло» —
        // ровно так его и прочитали в первом живом прогоне.
        let segments = 0;
        let signals = 0;
        let conversationStatus: string | null = null;
        if (i.conversationId) {
          const transcript = await this.prisma.transcript.findUnique({
            where: { conversationId: i.conversationId as string },
            select: {
              segments: { select: { _count: { select: { signals: true } } } },
            },
          });
          segments = transcript?.segments.length ?? 0;
          signals = transcript?.segments.reduce((acc, s) => acc + s._count.signals, 0) ?? 0;
          // Статус разговора — вторая ось прогресса: для ручного пути
          // он различает «расшифровка у AssemblyAI» и «транскрипт уже
          // в БД, ждёт анализа», чего по одной джобе не увидеть.
          const conv = await this.prisma.conversation.findUnique({
            where: { id: i.conversationId as string },
            select: { status: true },
          });
          conversationStatus = conv?.status ?? null;
        }
        // Сырьё для приблизительного прогресс-индикатора PROCESSING:
        // провайдер прогресса НЕ отдаёт, поэтому наружу идут ФАКТЫ
        // (фаза джобы + когда поставлена + длительность ролика), а
        // оценка процента — на клиенте и честно помечена как «≈».
        let job: {
          status: string;
          startedAt: Date;
          submitted: boolean;
          retryCount: number;
          /** Последняя заметка воркера (транзиентные ошибки опроса,
           * причина рекью) — различает «считается» и «ретраи». */
          note: string | null;
          /** Точный момент срабатывания сторожевой — вместо «до 2 ч». */
          leaseExpiresAt: Date | null;
        } | null = null;
        if (i.aiJobId && i.status === 'PROCESSING') {
          const j = await this.prisma.aIJob.findUnique({
            where: { id: i.aiJobId as string },
            select: {
              status: true,
              createdAt: true,
              externalInteractionId: true,
              retryCount: true,
              partialResult: true,
              leaseExpiresAt: true,
            },
          });
          if (j) {
            job = {
              status: j.status,
              startedAt: j.createdAt,
              submitted: j.externalInteractionId != null,
              retryCount: j.retryCount,
              note: j.partialResult ? j.partialResult.slice(0, 200) : null,
              leaseExpiresAt: j.leaseExpiresAt,
            };
          }
        }
        return {
          id: i.id,
          youtubeVideoId: i.youtubeVideoId,
          title: i.title,
          status: i.status,
          conversationId: i.conversationId ?? null,
          autoAnalysisError: (i.autoAnalysisError as string | null | undefined) ?? null,
          segments,
          signals,
          durationSeconds: (i.durationSeconds as number | null | undefined) ?? null,
          conversationStatus,
          job,
        };
      }),
    );
    return { queue: { id: full.id, title: full.title, items } };
  }

  /** Повторный запуск автоматического разбора элемента песочной
   * очереди — после 429/сбоя/сторожевой. Вся логика (владелец, guard
   * активной джобы, переиспользование разговора) — в продовом
   * MediaReviewAutoService.retryAnalysis: песочница ничего не обходит. */
  async retryQueueItem(operatorUserId: string, itemId: string) {
    await this.assertOperator(operatorUserId);
    if (!itemId?.trim()) {
      throw new BadRequestException('itemId обязателен');
    }
    return this.mediaReviewAuto.retryAnalysis(operatorUserId, itemId.trim());
  }

  /** Содержимое разбора для аккордеона песочной очереди: сегменты с
   * таймкодами, спикерами и сигналами. Только чтение; те же данные,
   * что видит пользователь в TMA, — песочница ничего не обходит. */
  async getAnalysis(operatorUserId: string, conversationId: string) {
    await this.assertOperator(operatorUserId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { conversationId },
      include: {
        segments: {
          orderBy: { startMs: 'asc' },
          include: {
            participant: { select: { diarizationLabel: true } },
            signals: true,
          },
        },
      },
    });
    if (!transcript) {
      return { language: null, segments: [] };
    }
    return {
      language: transcript.language ?? null,
      segments: transcript.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        speaker: s.participant?.diarizationLabel ?? null,
        text: s.text,
        signals: s.signals.map((sig) => ({
          type: sig.signalType,
          channel: sig.paralinguisticChannel ?? null,
          confidence: sig.confidence ?? null,
        })),
      })),
    };
  }

  /** Пункт [progress-diagnose] — автоматический анализ «а не сбой ли
   * это» для зависшего PROCESSING. Делает то, что оператор делал бы
   * руками через SQL и curl: собирает факты о джобе, спрашивает у
   * провайдера ЖИВОЙ статус интеракции, чинит единственную известную
   * аномалию (RUNNING без lease — такую джобу сторожевая никогда не
   * закроет), запускает внеочередной тик опроса и выносит вердикт
   * словами. Ничего разрушительного: те же операции, что делает крон. */
  async diagnoseQueueItem(operatorUserId: string, itemId: string) {
    await this.assertOperator(operatorUserId);
    const item = await this.prisma.mediaReviewQueueItem.findFirst({
      where: { id: itemId, queue: { userId: operatorUserId } },
      select: { id: true, status: true, aiJobId: true, conversationId: true },
    });
    if (!item) {
      throw new BadRequestException('Элемент очереди не найден');
    }

    const steps: string[] = [];
    let fixedMissingLease = false;

    if (!item.aiJobId) {
      return {
        verdict: 'У элемента нет джобы разбора — нажмите «Повторить», чтобы поставить её заново',
        steps,
        fixedMissingLease,
        pollResult: null,
        inspection: null,
      };
    }

    // 1. Факты + живой статус у провайдера (без записи).
    const before = await this.aiRouter.inspectJob(item.aiJobId);
    steps.push(
      `джоба: ${before.jobStatus}, попыток ${before.retryCount}, задача ${before.submitted ? 'поставлена провайдеру' : 'ещё не поставлена'}`,
    );
    if (before.providerStatus) steps.push(`живой статус у провайдера: ${before.providerStatus}`);
    if (before.providerError) steps.push(`опрос провайдера падает: ${before.providerError}`);
    if (before.note) steps.push(`последняя заметка воркера: ${before.note}`);

    // 2. Самолечение аномалии: RUNNING без lease — вне досягаемости
    // сторожевой (reap ищет lease < now). Ставим короткий lease, чтобы
    // джоба вернулась под её защиту.
    if (before.jobStatus === 'RUNNING' && !before.leaseExpiresAt) {
      await this.prisma.aIJob.update({
        where: { id: item.aiJobId },
        data: { leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000) },
      });
      fixedMissingLease = true;
      steps.push('АНОМАЛИЯ ИСПРАВЛЕНА: у RUNNING-джобы не было lease (сторожевая её не видела) — назначен новый, 30 минут');
    }

    // 3. Внеочередной тик опроса — тот же код, что дергает крон.
    let pollResult: { completed: number; failed: number; waiting: number } | null = null;
    try {
      pollResult = await this.aiRouter.pollRunning(10);
      steps.push(`внеочередной опрос: завершено ${pollResult.completed}, упало ${pollResult.failed}, ждут ${pollResult.waiting}`);
    } catch (err) {
      steps.push(`внеочередной опрос не прошёл: ${String(err).slice(0, 200)}`);
    }

    // 4. Состояние после — и вердикт.
    const after = await this.aiRouter.inspectJob(item.aiJobId);
    let itemAfter = await this.prisma.mediaReviewQueueItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { status: true, autoAnalysisError: true },
    });

    // 5. Дозапись оборванного персистенса: джоба COMPLETED (inference
    // уже оплачен и записан), а элемент так и висит — записываем разбор
    // из готового результата, не дергая провайдера повторно.
    if (after.jobStatus === 'COMPLETED' && itemAfter.status === 'PROCESSING') {
      const inference = await this.prisma.aIInference.findFirst({
        where: { aiJobId: item.aiJobId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (inference) {
        try {
          await this.mediaReviewAuto.persistAnalysis(item.id, inference.id);
          steps.push('персистенс был оборван — разбор дозаписан из готового результата провайдера');
          itemAfter = await this.prisma.mediaReviewQueueItem.findUniqueOrThrow({
            where: { id: item.id },
            select: { status: true, autoAnalysisError: true },
          });
        } catch (err) {
          steps.push(`дозапись разбора не прошла: ${String(err).slice(0, 200)}`);
        }
      }
    }

    let verdict: string;
    if (itemAfter.status === 'DONE' || after.jobStatus === 'COMPLETED') {
      verdict =
        itemAfter.status === 'DONE'
          ? 'Не сбой провайдера: результат готов и записан — обновите очередь'
          : 'Результат у провайдера готов, но запись разбора не проходит — см. шаги';
    } else if (after.jobStatus === 'FAILED') {
      verdict = `Сбой подтверждён, джоба закрыта с причиной: ${itemAfter.autoAnalysisError ?? after.note ?? 'см. журнал'} — доступно «Повторить»`;
    } else if (before.providerStatus === 'in_progress' || before.providerStatus === 'queued') {
      verdict = `Не сбой: провайдер подтверждает, что задача ${before.providerStatus === 'queued' ? 'в его очереди' : 'считается'} — остаётся ждать${fixedMissingLease ? ' (и теперь под защитой сторожевой)' : ''}`;
    } else if (before.providerError) {
      verdict = 'Похоже на сбой опроса: провайдер отвечает ошибкой (см. шаги) — если повторится, джобу закроет сторожевая, дальше «Повторить»';
    } else {
      verdict = 'Однозначного вердикта нет — см. шаги; сторожевая закроет джобу по lease, если движения не будет';
    }

    return { verdict, steps, fixedMissingLease, pollResult, inspection: after };
  }

  /** Fact Check по разобранному видео — поиск по базе опубликованных
   * фактчеков (Google Fact Check Tools). НЕ вердикт о правдивости:
   * отсутствие совпадений ничего не доказывает; результат — материал
   * для человека. Делегирует DiscrepancyAnalysisService — там уже
   * живут кэш, пагинация и ключ FACT_CHECK_TOOLS_API_KEY. */
  async factCheckConversation(operatorUserId: string, conversationId: string) {
    await this.assertOperator(operatorUserId);
    return this.discrepancy.factCheckConversationSegments(conversationId);
  }

  async getConversation(operatorUserId: string, conversationId: string) {
    await this.assertOperator(operatorUserId);
    const conversation = await this.conversations.get(operatorUserId, conversationId);
    if (!conversation) {
      throw new BadRequestException(`Conversation ${conversationId} не найден`);
    }
    return {
      id: conversation.id,
      status: conversation.status,
      externalJobId: conversation.externalTranscriptionJobId,
      segments: conversation.transcript?.segments?.length ?? 0,
      participants: conversation.participants?.length ?? 0,
      updatedAt: conversation.updatedAt,
    };
  }

  /** Шаг 8: три вида анализа — те же сервисы, что и продовые
   * эндпоинты, от имени оператора. Порядок важен для статуса DONE в
   * очереди медиа-разбора: ANALYZED ставит только turning-points. */
  async analyze(operatorUserId: string, conversationId: string, kind: SandboxAnalysisKind) {
    await this.assertOperator(operatorUserId);
    switch (kind) {
      case 'manipulation':
        return this.manipulation.detect(operatorUserId, conversationId);
      case 'discrepancy':
        return this.discrepancy.detect(operatorUserId, conversationId);
      case 'turning-points':
        return this.turningPoints.detect(operatorUserId, conversationId);
      default:
        throw new BadRequestException(`Неизвестный вид анализа: ${String(kind)}`);
    }
  }
}
