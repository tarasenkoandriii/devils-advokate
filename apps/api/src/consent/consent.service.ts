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
import { ConsentType, PrivacyProcessingMode } from '@prisma/client';

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

  async hasActiveConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
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
    return record !== null;
  }

  /** Бросает ForbiddenException, если согласие не дано — используется
   * в местах, где отсутствие согласия должно останавливать операцию
   * (например AIRouterService перед вызовом внешнего провайдера),
   * а не просто молча пропускать шаг. */
  async requireConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
  ): Promise<void> {
    const has = await this.hasActiveConsent(userId, consentType, projectId);
    if (!has) {
      throw new ForbiddenException(
        `Consent required: ${consentType} (userId=${userId}${projectId ? `, projectId=${projectId}` : ''})`,
      );
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
  async revoke(userId: string, consentType: ConsentType, projectId?: string): Promise<void> {
    await this.prisma.consentRecord.updateMany({
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
  }
}
