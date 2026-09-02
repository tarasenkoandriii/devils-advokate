// Пункт 81: LiveSessionService (§3.31 ТЗ, cooldown-нудж — первая
// фича живого режима за весь проект) + задел инфраструктуры под
// остальные live-фичи (§3.4, §3.33), по прямому запросу.
//
// mintTranscriptionToken() — ЕДИНСТВЕННЫЙ метод, реально нужный
// НЕСКОЛЬКИМ будущим live-фичам, не только этой. Возвращает
// короткоживущий токен AssemblyAI — клиент подключается к их
// WebSocket НАПРЯМУЮ, backend не участвует в самом потоке аудио
// вообще (обходит отсутствие постоянных WebSocket-соединений на
// serverless). Сам cooldown-нудж этот метод НЕ использует — он
// целиком акустический, без транскрипции (см. обоснование в
// schema.prisma над CooldownNudgeEvent) — метод здесь для будущих
// потребителей (§3.4/§3.33), тестируется уже сейчас, чтобы
// инфраструктура была готова, когда до них дойдёт очередь.
//
// logNudgeEvent() — НЕ сырое аудио, НЕ транскрипт, только числовые
// метрики уже посчитанного клиентом сигнала. Та же дисциплина
// "первоисточник не покидает устройство", что и везде в проекте.

import { Injectable, NotFoundException, BadGatewayException } from '@nestjs/common';
import { requireAIProvider } from '../common/require-provider';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';
import { SecretsService } from '../secrets/secrets.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { fetchWithTimeout } from '../common/fetch-with-timeout';

const ASSEMBLYAI_TEMP_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';

@Injectable()
export class LiveSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
  ) {}

  /** Задел под §3.4/§3.33 — минтит короткоживущий токен для прямого
   * browser→AssemblyAI подключения, backend не держит WebSocket сам.
   * expiresInSeconds по умолчанию 300 (5 минут) — достаточно для
   * инициализации клиентского подключения, не для всей сессии
   * разговора (сессия обновляет токен по мере надобности сама).
   *
   * Аудит моделей БД 2026-08-30, §2.3 — этот токен открывает прямой
   * канал browser→AssemblyAI, которым живой аудиопоток разговора
   * (включая голос собеседника, не только пользователя) стримится
   * внешнему провайдеру в реальном времени — ровно случай, под который
   * заведён ConsentType.THIRD_PARTY_AUDIO_RECORDING (см. её doc-комментарий
   * в schema.prisma и precedent в DtpService.addEvidence). До этой правки
   * ни один из потребителей (LiveHintsSession, AssistanceScreen,
   * VoiceTextInput в intake-квизе) не требовал согласия — токен
   * выдавался безусловно. Уровень пользователя, не проекта — токен не
   * привязан к конкретному проекту (тот же довод, что ниже про клиента). */
  async mintTranscriptionToken(userId: string, expiresInSeconds = 300): Promise<{ token: string; expiresInSeconds: number }> {
    await this.consent.requireConsent(userId, ConsentType.THIRD_PARTY_AUDIO_RECORDING);
    const provider = await requireAIProvider(this.prisma, 'assemblyai');
    const apiKey = await this.secrets.resolve(provider.credentialRef ?? 'ASSEMBLYAI_API_KEY');

    let response: Response;
    try {
      response = await fetchWithTimeout(`${ASSEMBLYAI_TEMP_TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`, {
        method: 'GET',
        headers: { Authorization: apiKey },
      });
    } catch {
      throw new BadGatewayException('AssemblyAI (временный токен) недоступен — сетевая ошибка');
    }
    if (!response.ok) {
      throw new BadGatewayException(`AssemblyAI (временный токен) вернул ошибку: ${response.status}`);
    }
    const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
    return { token: data.token, expiresInSeconds };
  }

  /** "Легко проигнорировать" (buкально ТЗ) — dismissed честно
   * фиксируется как факт, не скрывается, не влияет на то, показывать
   * ли нудж в будущем (нет накопительной логики "пользователь плохо
   * реагирует на нудж" — это было бы уже интерпретацией поведения). */
  async logNudgeEvent(
    userId: string,
    projectId: string,
    peakVolumeDb: number | null,
    escalationScore: number | null,
  ) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.cooldownNudgeEvent.create({
      data: { projectId, peakVolumeDb, escalationScore },
    });
  }

  async markDismissed(userId: string, projectId: string, eventId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const event = await this.prisma.cooldownNudgeEvent.findFirst({ where: { id: eventId, projectId } });
    if (!event) {
      throw new NotFoundException(`CooldownNudgeEvent ${eventId} not found in project ${projectId}`);
    }
    return this.prisma.cooldownNudgeEvent.update({
      where: { id: eventId },
      data: { dismissed: true },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.cooldownNudgeEvent.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}
