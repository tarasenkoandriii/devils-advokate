// ConsentService — первая реализация сервисного слоя поверх
// ConsentRecord (чекпоинт 1, пункт 8). Закрывает TODO, оставленный в
// AIRouterService: "проверить ConsentRecord(consentType=EXTERNAL_AI)
// перед вызовом внешнего провайдера".
//
// Namespace выбора: считаем согласие активным, если granted=true И
// revokedAt=null. version не участвует в проверке "активно ли" —
// она нужна только чтобы понимать, под какой редакцией политики
// пользователь согласился (для юридического аудита), не для решения
// "пускать ли сейчас".

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIJobStatus, ConsentType, PrivacyProcessingMode, Prisma } from '@prisma/client';
import { REVOCATION_EFFECTS, RevocationReport } from './consent-revocation-effects';
import { coversPurpose, locationPurposeSpec } from './location-purposes';

export interface GrantConsentInput {
  userId: string;
  consentType: ConsentType;
  version: string;
  source: string;
  purposes?: string[];
  projectId?: string;
}

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пункт [consent-purpose] 2026-09-05: у геолокации согласие даётся
   * НЕ на тип, а на применения — `purposes[]` заполнялся обеими
   * дверями и не читался нигде, поэтому «разрешил погоду» открывало
   * запись координат навсегда. `purpose` необязателен только там, где
   * применения нет как понятия (остальные типы согласий); для
   * LOCATION он обязателен по проверке ниже. */
  async hasActiveConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
    purpose?: string,
  ): Promise<boolean> {
    const record = await this.prisma.consentRecord.findFirst({
      where: {
        userId,
        consentType,
        granted: true,
        revokedAt: null,
        // Глобальное согласие (projectId=null) действует для любого
        // проекта; согласие, привязанное к конкретному projectId,
        // действует только для него — поэтому при известном проекте
        // ищем оба варианта, а без проекта — ТОЛЬКО глобальное.
        //
        // ПОВТОРНЫЙ АУДИТ 2026-08-30, реальная дыра: раньше здесь стояло
        // `OR: [{ projectId: null }, { projectId: projectId ?? undefined }]`.
        // Prisma вырезает undefined-поля из фильтра, поэтому при вызове
        // без projectId вторая ветка вырождалась в `{}`, а пустой объект
        // внутри OR не ограничивает ничего — подходила ЛЮБАЯ запись.
        // Следствие: согласие, выданное точечно на один проект, работало
        // как глобальное для всех «безпроектных» проверок —
        // THIRD_PARTY_AUDIO_RECORDING (live-транскрипция), HEALTH_DATA,
        // VOICE_BIOMETRIC, VOICE_PROCESSING, LOCATION. То есть ровно там,
        // где цена ошибки максимальная.
        ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : { projectId: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (record === null) return false;
    if (purpose === undefined) return true;
    // Опечатка в имени применения не должна означать «разрешено»:
    // неизвестное применение не покрывается ничем.
    if (locationPurposeSpec(purpose) === null) return false;
    return coversPurpose(record.purposes, purpose);
  }

  /** Бросает ForbiddenException, если согласие не дано — используется
   * в местах, где отсутствие согласия должно останавливать операцию
   * (например AIRouterService перед вызовом внешнего провайдера),
   * а не просто молча пропускать шаг. */
  async requireConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
    purpose?: string,
  ): Promise<void> {
    const has = await this.hasActiveConsent(userId, consentType, projectId, purpose);
    if (!has) {
      // Пункт [error-language] 2026-09-04. Здесь стояло
      // `Consent required: ${consentType} (userId=..., projectId=...)`.
      // Две беды сразу: человек читал английскую строку СО СВОИМ
      // внутренним идентификатором внутри, и клиент был вынужден
      // опознавать эту ситуацию по подстроке в тексте
      // (`err.message.includes('PUBLIC_SHARING')` в TMA) — то есть текст
      // сообщения стал негласным контрактом, и любая его правка молча
      // сломала бы экран.
      //
      // Теперь: человеку — фраза на его языке, клиенту — устойчивый
      // `code` и `consentType` в деталях (тот же приём, что у
      // COMPANY_REQUIRED, см. api-exception.filter.ts). Идентификаторы
      // из текста убраны: человеку они ничего не говорят.
      // Пункт [consent-purpose] 2026-09-05: применение уходит клиенту
      // отдельным полем, а не подстрокой в тексте — экран должен уметь
      // открыть ИМЕННО ту дверь, которой не хватило, и показать слова
      // именно этого применения.
      const spec = purpose ? locationPurposeSpec(purpose) : null;
      throw new ForbiddenException({
        message: spec
          ? `Для этого нужно отдельное согласие: ${spec.label}. Его спросят перед тем, как продолжить.`
          : 'Для этого действия нужно ваше согласие — его спросят перед тем, как продолжить.',
        code: 'CONSENT_REQUIRED',
        consentType,
        ...(purpose ? { purpose } : {}),
      });
    }
  }

  /**
   * ПОВТОРНЫЙ АУДИТ 2026-08-30 — единая проверка «можно ли выпускать
   * аудио пользователя за пределы нашего периметра».
   *
   * Была найдена дыра целого класса: преамбула из трёх проверок
   * (MAXIMUM_PRIVACY + RECORDING + EPHEMERAL_SERVER) стояла только в
   * ConversationsService.requestTranscription() — то есть на шаге
   * «запустить транскрибацию». Но байты файла уходят провайдеру РАНЬШЕ,
   * на шаге загрузки (streamUpload → POST /v2/upload), где проверялось
   * только владение разговором. А в спарринге и чате по материалам
   * ConsentService не был подключён вообще — ни одной из трёх проверок,
   * при том что там пользователь наговаривает реплику в микрофон.
   *
   * Метод здесь, а не приватным хелпером в одном из сервисов, именно
   * потому, что точек пять и они в разных модулях: копия проверки в
   * каждом — тот же способ разъехаться, который эту дыру и создал.
   *
   * Порядок проверок значим: сначала режим приватности (жёсткий запрет,
   * не «дайте согласие»), потом согласия — иначе пользователю в режиме
   * MAXIMUM_PRIVACY предлагалось бы выдать согласие, которое всё равно
   * ничего не разблокирует.
   */
  async assertAudioMayLeaveDevice(userId: string, projectId?: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (user.privacyProcessingMode === PrivacyProcessingMode.MAXIMUM_PRIVACY) {
      throw new ForbiddenException(
        'privacyProcessingMode=MAXIMUM_PRIVACY запрещает передачу аудио внешнему провайдеру — переключитесь на BALANCED или MAXIMUM_QUALITY',
      );
    }

    await this.requireConsent(userId, ConsentType.RECORDING, projectId);
    await this.requireConsent(userId, ConsentType.EPHEMERAL_SERVER, projectId);
  }

  /**
   * Аудит согласий 2026-09-03. Живая расшифровка — второй способ выпустить
   * аудио наружу, и он устроен иначе: браузер стримит звук провайдеру
   * НАПРЯМУЮ, на нашем сервере не оседает ни байта. Из-за этого он не
   * проходил через assertAudioMayLeaveDevice() — и вместе с EPHEMERAL_SERVER
   * терял проверку, которая согласием вообще не является:
   * privacyProcessingMode = MAXIMUM_PRIVACY означает «аудио не уходит
   * внешнему провайдеру», а тут оно уходило непрерывным потоком. Признак,
   * что это именно пробел, а не решение: операторская песочница ту же
   * облачную расшифровку в этом режиме отказывалась запускать («согласиями
   * не обходится»), а продуктовый путь — запускал.
   *
   * Чего этот метод НЕ требует и почему:
   *   • EPHEMERAL_SERVER — обещание «файл побудет на нашем сервере и
   *     удалится»; здесь файла на нашем сервере нет вовсе, требовать
   *     согласие на то, чего не происходит, — обман в другую сторону;
   *   • RECORDING — «запись собственных разговоров»; этим же токеном
   *     пользуется голосовой ввод квиза, где никакого разговора нет.
   * Остаётся THIRD_PARTY_AUDIO_RECORDING — согласие ровно про то, что
   * здесь и происходит: чужой голос уходит на распознавание.
   */
  async assertRealtimeAudioAllowed(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.privacyProcessingMode === PrivacyProcessingMode.MAXIMUM_PRIVACY) {
      throw new ForbiddenException(
        'privacyProcessingMode=MAXIMUM_PRIVACY запрещает передачу аудио внешнему провайдеру — живая расшифровка недоступна, переключитесь на BALANCED или MAXIMUM_QUALITY',
      );
    }
    await this.requireConsent(userId, ConsentType.THIRD_PARTY_AUDIO_RECORDING);
  }

  async grant(input: GrantConsentInput) {
    return this.prisma.consentRecord.create({
      data: {
        userId: input.userId,
        consentType: input.consentType,
        version: input.version,
        source: input.source,
        purposes: input.purposes ?? [],
        projectId: input.projectId,
        granted: true,
        grantedAt: new Date(),
      },
    });
  }

  /** Отзыв — не удаляет запись (юридический след важнее), только
   * помечает revokedAt. Если consentType=LOCATION, это отзывает ВСЕ
   * purposes разом (§3.32 ТЗ) — потому что purposes хранятся на одной
   * записи, а не на трёх отдельных (см. Prisma-README, пункт 8,
   * инвариант 24). */
  async revoke(userId: string, consentType: ConsentType, projectId?: string): Promise<RevocationReport> {
    const marked = await this.prisma.consentRecord.updateMany({
      where: {
        userId,
        consentType,
        revokedAt: null,
        // ЗДЕСЬ АСИММЕТРИЯ С hasActiveConsent() — НАМЕРЕННАЯ, не
        // недосмотр. Проверка «есть ли согласие» без projectId должна
        // быть строгой (только глобальное), а отзыв без projectId —
        // наоборот, максимально широким: пользователь, нажимающий
        // «отозвать согласие» в Privacy Center, имеет в виду «везде», а
        // не «кроме тех проектов, где я когда-то согласился точечно».
        // Поэтому фильтра по projectId нет вообще — отзываются все
        // активные записи этого типа. Правило простое: сомнение
        // трактуется в пользу отзыва, а не в пользу обработки данных.
        ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : {}),
      },
      data: { revokedAt: new Date(), granted: false },
    });

    // Пункт [consent-revocation] 2026-09-04 — последствия отзыва, а не
    // только его пометка. Для одиннадцати типов из тринадцати
    // последствий нет и быть не должно: согласие разрешало БУДУЩЕЕ
    // действие, отзыв его прекращает. Для двух — есть, и раньше не
    // происходило ничего (разбор — в consent-revocation-effects.ts).
    //
    // Эффекты выполняются ПОСЛЕ пометки: если что-то из них упадёт,
    // согласие уже отозвано, то есть новых действий под ним не будет —
    // это важнее, чем довести уборку. Отчёт при этом покажет, что
    // сделано, а что нет.
    const alsoDone: string[] = [];
    const effect = REVOCATION_EFFECTS[consentType];

    if (consentType === ConsentType.PUBLIC_SHARING) {
      // Главное найденное: `enableSharing()` требовал согласия, а
      // `publicView(token)` его больше никогда не перепроверял —
      // отозвав согласие, человек видел «готово», и страница
      // продолжала открываться у всех, кому он дал ссылку.
      const closed = await this.prisma.project.updateMany({
        where: { ownerId: userId, publicShareToken: { not: null } },
        data: { publicShareToken: null },
      });
      if (closed.count > 0) alsoDone.push(effect.alsoDoes as string);
    }

    if (consentType === ConsentType.EXTERNAL_AI) {
      // Пункт [revoked-then-sent] 2026-09-06 — отзыв обещал человеку
      // БЕЗУСЛОВНО: «новых запросов от вашего имени больше не будет».
      // Обещание не выполнялось: согласие проверялось один раз, при
      // ПОСТАНОВКЕ задачи в очередь, а уходила она провайдеру позже —
      // окно очереди пятнадцать минут, и каждая неудачная попытка
      // возвращает задачу в очередь заново.
      //
      // Снимаются только QUEUED: у них `pendingRequest` ещё не
      // отправлен никуда. RUNNING не трогаем — их содержимое провайдер
      // уже видел, и делать вид, что отмена что-то там отменяет, было
      // бы ровно той неправдой, которую этот пункт и убирает. О них
      // сказано отдельно, словами, в `doesNotUndo`.
      const cancelled = await this.prisma.aIJob.updateMany({
        where: { requestUserId: userId, status: AIJobStatus.QUEUED },
        data: {
          status: AIJobStatus.FAILED,
          completedAt: new Date(),
          partialResult: 'отменено: согласие на внешний AI отозвано, задача снята из очереди до отправки провайдеру',
          pendingRequest: Prisma.DbNull,
          leaseExpiresAt: null,
        },
      });
      if (cancelled.count > 0) alsoDone.push(effect.alsoDoes as string);
    }

    if (consentType === ConsentType.VOICE_BIOMETRIC) {
      // Правильный путь в проекте был — `VoiceEmbeddingService.forget()`
      // удаляет вектор и только потом отзывает согласие. Общий
      // эндпоинт `DELETE /consent/:type`, которым человек и пользуется
      // в Центре приватности, шёл мимо него. Здесь та же операция:
      // `deleteMany` идемпотентен, так что путь через forget() не
      // ломается и не удваивается.
      const forgotten = await this.prisma.voiceEmbedding.deleteMany({ where: { userId } });
      if (forgotten.count > 0) alsoDone.push(effect.alsoDoes as string);
    }

    return {
      consentType,
      // «Нечего было отзывать» и «отозвали» — разные утверждения, и
      // человек должен видеть, какое из них про него.
      revoked: marked.count > 0,
      recordsRevoked: marked.count,
      alsoDone,
      doesNotUndo: effect.doesNotUndo,
    };
  }
}
