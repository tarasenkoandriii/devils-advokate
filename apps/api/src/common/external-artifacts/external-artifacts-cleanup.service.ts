// Аудит 2026-09-02 (продолжение) — что живёт ВНЕ базы и не удаляется каскадом.
//
// У проекта три вида внешних артефактов, у которых в БД только ссылка:
//   1. доказательства ДТП в Vercel Blob (DtpEvidenceItem.blobUrl);
//   2. транзитный аудиофайл разговора в приватном Blob
//      (Conversation.audioBlobPathname — ждёт расшифровку/паралингвистику);
//   3. задача распознавания у STT-провайдера (Conversation в TRANSCRIBING,
//      голосовая реплика PENDING/PROCESSING) — с записью и файлом у него.
//
// `prisma.project.delete` / `prisma.user.delete` каскадом снимают СТРОКИ —
// артефакты остаются: файл без ссылки в хранилище навсегда (сторожевая
// ищет по строкам, а строки уже нет), задача у провайдера — на весь его
// retention. До этой правки удаление АККАУНТА знало только про (1), а
// удаление ПРОЕКТА («Удалить всё» на экране проекта и в центре
// приватности) — ни про что.
//
// Один сервис на оба пути, потому что набор артефактов один и тот же, а
// разница — только в том, чьи проекты: один или все у пользователя.
// Всё best-effort: отказ удаления файла не должен оставлять строку в БД
// (право на удаление сильнее чистоты хранилища), но каждый отказ
// считается и возвращается вызывающему коду — для ответа пользователю и
// журнала аудита.
import { Injectable, Logger } from '@nestjs/common';
import { ConversationProcessingStatus, SparringVoiceReplyStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsService } from '../../secrets/secrets.service';
import { AudioBlobService } from '../../conversations/audio-blob.service';
import { SttService, parseSttJobId } from '../../stt/stt.service';
import { deleteBlob } from '../vercel-blob';
import { resolveBlobToken } from '../blob-token';
import { isUnknownEnumValueError, warnEnumMigrationLagOnce } from '../enum-migration-lag';

export interface ExternalArtifactsReport {
  /** Доказательства ДТП: найдено / удалено / не удалось. */
  evidenceBlobs: number;
  evidenceDeleted: number;
  evidenceFailed: number;
  /** Транзитные аудиофайлы разговоров: НАЙДЕНО / удалено / не удалось.
   *
   * Пункт [discarded-nothing-said-three] 2026-09-30: поле было одно, и
   * имя его означало «сколько было», а подпись на экране говорила
   * «удалено: N». Удаление здесь best-effort по честной причине
   * (вебхук приходит один раз, ронять его обработку из-за неудачного
   * удаления файла дороже), но причина глушения не делает верным
   * утверждение об исходе. Три числа вместо одного — как у
   * доказательств ДТП, где это уже закрыто Пунктом
   * [delete-says-done]. */
  conversationAudioBlobs: number;
  conversationAudioDeleted: number;
  conversationAudioFailed: number;
  /** Задачи распознавания в полёте: НАЙДЕНО / отозвано / не отозвано.
   *  Отзыв не состоится, если провайдер неизвестен, если он отзыва не
   *  умеет (ElevenLabs — универсальный фоллбек — не умеет) или если
   *  запрос упал. Прежде счётчик «отозвано» рос во всех трёх случаях. */
  sttJobsInFlight: number;
  sttJobsDiscarded: number;
  sttJobsFailed: number;
}

@Injectable()
export class ExternalArtifactsCleanupService {
  private readonly logger = new Logger(ExternalArtifactsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly audioBlob: AudioBlobService,
    private readonly stt: SttService,
  ) {}

  /** Все проекты пользователя — для удаления аккаунта. */
  async discardForUser(userId: string): Promise<ExternalArtifactsReport> {
    return this.discard({ project: { ownerId: userId } });
  }

  /** Один проект — для «Удалить всё» на проекте. */
  async discardForProject(projectId: string): Promise<ExternalArtifactsReport> {
    return this.discard({ project: { id: projectId } });
  }

  private async discard(scope: { project: { ownerId: string } | { id: string } }): Promise<ExternalArtifactsReport> {
    const report: ExternalArtifactsReport = {
      evidenceBlobs: 0,
      evidenceDeleted: 0,
      evidenceFailed: 0,
      conversationAudioBlobs: 0,
      conversationAudioDeleted: 0,
      conversationAudioFailed: 0,
      sttJobsInFlight: 0,
      sttJobsDiscarded: 0,
      sttJobsFailed: 0,
    };

    // 1) доказательства ДТП
    const evidence = await this.prisma.dtpEvidenceItem.findMany({
      where: { config: scope },
      select: { id: true, blobUrl: true },
    });
    report.evidenceBlobs = evidence.length;
    if (evidence.length > 0) {
      const token = await resolveBlobToken(this.secrets).catch(() => null);
      for (const item of evidence) {
        if (!token) {
          report.evidenceFailed++;
          continue;
        }
        // Пункт [delete-says-done] 2026-09-06: `catch` здесь ловил
        // пустоту — `deleteBlob` не бросал НИЧЕГО и не проверял даже
        // код ответа, поэтому `evidenceDeleted++` выполнялся всегда.
        // Счётчик «удалено» был завышен по построению, и именно он
        // уходит в запись аудита при удалении аккаунта: человек читал,
        // что его доказательства ДТП убраны из внешнего хранилища, при
        // том что они могли остаться.
        const outcome = await deleteBlob(token, item.blobUrl);
        if (outcome.deleted) report.evidenceDeleted++;
        else report.evidenceFailed++;
      }
    }

    // 2–3) аудио разговоров и задачи в полёте
    const conversations = await this.prisma.conversation.findMany({
      where: {
        ...scope,
        OR: [
          { audioBlobPathname: { not: null } },
          { status: ConversationProcessingStatus.TRANSCRIBING, externalTranscriptionJobId: { not: null } },
        ],
      },
      select: { id: true, audioBlobPathname: true, status: true, externalTranscriptionJobId: true },
    });
    for (const c of conversations) {
      if (c.audioBlobPathname) {
        report.conversationAudioBlobs++;
        // Пункт [discarded-nothing-said-three] 2026-09-30: инкремент
        // стоял ДО вызова и был единственным — то есть числом
        // найденных, напечатанным как «удалено».
        if (await this.audioBlob.deleteByPathname(c.audioBlobPathname)) report.conversationAudioDeleted++;
        else report.conversationAudioFailed++;
      }
      if (c.status === ConversationProcessingStatus.TRANSCRIBING && c.externalTranscriptionJobId) {
        const { provider, externalJobId } = parseSttJobId(c.externalTranscriptionJobId);
        report.sttJobsInFlight++;
        if (await this.stt.discardOrphan(provider, externalJobId)) report.sttJobsDiscarded++;
        else report.sttJobsFailed++;
      }
    }

    const [sparringJobs, materialJobs] = await this.findInFlightVoiceJobs(scope);
    for (const job of [...sparringJobs, ...materialJobs]) {
      const { provider, externalJobId } = parseSttJobId(job.externalTranscriptionJobId);
      report.sttJobsInFlight++;
      if (await this.stt.discardOrphan(provider, externalJobId)) report.sttJobsDiscarded++;
      else report.sttJobsFailed++;
    }

    if (report.evidenceFailed > 0) {
      this.logger.warn(`Внешние артефакты: не удалось удалить ${report.evidenceFailed} файлов доказательств — нужна ручная чистка`);
    }
    if (report.conversationAudioFailed > 0) {
      this.logger.warn(
        `Внешние артефакты: не удалось удалить ${report.conversationAudioFailed} транзитных аудиофайлов — нужна ручная чистка`,
      );
    }
    if (report.sttJobsFailed > 0) {
      this.logger.warn(
        `Внешние артефакты: ${report.sttJobsFailed} задач распознавания НЕ отозвано у провайдера — запись остаётся у него до конца retention`,
      );
    }
    return report;
  }

  /** Голосовые реплики в полёте. До применения миграции перечисления
   * значение PROCESSING неизвестно базе (22P02) — тогда ищем только
   * PENDING: удаление аккаунта/проекта не должно падать из-за отставания
   * миграции, а PROCESSING без миграции в базе и не появляется. */
  private async findInFlightVoiceJobs(scope: { project: { ownerId: string } | { id: string } }) {
    const query = (statuses: SparringVoiceReplyStatus[]) =>
      Promise.all([
        this.prisma.sparringVoiceReplyJob.findMany({
          where: { status: { in: statuses }, sparringSession: scope },
          select: { externalTranscriptionJobId: true },
        }),
        this.prisma.materialChatVoiceReplyJob.findMany({
          where: { status: { in: statuses }, materialChatSession: { workingMaterial: scope } },
          select: { externalTranscriptionJobId: true },
        }),
      ]);
    try {
      return await query([SparringVoiceReplyStatus.PENDING, SparringVoiceReplyStatus.PROCESSING]);
    } catch (err) {
      if (!isUnknownEnumValueError(err)) throw err;
      warnEnumMigrationLagOnce(this.logger, 'ExternalArtifactsCleanupService');
      return query([SparringVoiceReplyStatus.PENDING]);
    }
  }
}
