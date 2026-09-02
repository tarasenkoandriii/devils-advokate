// Пункт [stt-multi] 2026-09-02 — маршрутизация распознавания речи.
//
// Одна точка, которая решает три вопроса и больше ни на что не влияет:
//   1. КТО ведёт этот язык (ru/uk → Soniox, en → AssemblyAI, неизвестно
//      → Soniox; см. stt-language.ts);
//   2. ЧТО делать, если он не ответил (фоллбек — ElevenLabs на
//      синхронной полосе, второй вебхучный провайдер на длинном файле);
//   3. КАК потом узнать, кто именно взял задачу, когда придёт вебхук.
//
// Ответ на (3) — ПРЕФИКС В ИДЕНТИФИКАТОРЕ: `soniox:<uuid>`. Схему это
// не трогает (в БД лежит та же строка externalTranscriptionJobId), а
// задачи, созданные до этой правки, читаются как есть — идентификатор
// без префикса означает AssemblyAI. Миграции не нужно, откат не ломает
// висящие задачи.
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SecretsService } from '../secrets/secrets.service';
import { resolveSttWebhookSecret } from '../common/webhook/stt-webhook.guard';
import type { ParsedTranscript } from '../conversations/transcription.service';
import { AssemblyAiSttProvider } from './assemblyai-stt.provider';
import { ElevenLabsSttProvider } from './elevenlabs-stt.provider';
import { SonioxSttProvider } from './soniox-stt.provider';
import {
  SttProvider,
  SttProviderError,
  SttRealtimeCredentials,
} from './stt-provider.interface';
import {
  SttProviderName,
  sttFallbackChain,
  sttLanguageHints,
  sttProviderForLanguage,
} from './stt-language';

/** Ссылка на секрет ключа провайдера в окружении. */
const CREDENTIAL_REF: Record<SttProviderName, string> = {
  soniox: 'SONIOX_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

export interface SttJobRef {
  provider: SttProviderName;
  externalJobId: string;
  /** То, что кладётся в БД: `<provider>:<id>`. */
  storedId: string;
}

/** Разбор идентификатора задачи. Без префикса — AssemblyAI: так
 *  выглядят все задачи, созданные до Пункта [stt-multi], и они обязаны
 *  дочитаться после выката. */
export function parseSttJobId(storedId: string): { provider: SttProviderName; externalJobId: string } {
  const separator = storedId.indexOf(':');
  if (separator === -1) return { provider: 'assemblyai', externalJobId: storedId };

  const prefix = storedId.slice(0, separator);
  if (prefix === 'soniox' || prefix === 'assemblyai' || prefix === 'elevenlabs') {
    return { provider: prefix, externalJobId: storedId.slice(separator + 1) };
  }
  // Двоеточие внутри самого идентификатора провайдера — не наш префикс.
  return { provider: 'assemblyai', externalJobId: storedId };
}

export function formatSttJobId(provider: SttProviderName, externalJobId: string): string {
  return `${provider}:${externalJobId}`;
}

/** Все написания одной и той же задачи — для поиска в БД.
 *
 * РЕВЬЮ 2026-09-02, БЛОКЕР: здесь стояло `formatSttJobId(provider, bare)`,
 * где provider выводился из самой строки, — то есть для ГОЛОГО id
 * (а именно голый id приносит вебхук: и AssemblyAI, и Soniox шлют свой
 * внутренний идентификатор без наших префиксов) вариант получался
 * только `assemblyai:<id>`. Вебхук Soniox не находил бы разговор
 * НИКОГДА: в базе лежит `soniox:<id>`. Расшифровка при этом уже
 * оплачена, а разговор навсегда завис бы в TRANSCRIBING.
 *
 * Поэтому варианты строятся по ВСЕМ провайдерам: строка короткая,
 * поиск идёт по индексируемому полю, а цена ошибки — потерянная
 * расшифровка. */
export function sttJobIdVariants(externalJobId: string): string[] {
  const { externalJobId: bare } = parseSttJobId(externalJobId);
  const all: SttProviderName[] = ['soniox', 'assemblyai', 'elevenlabs'];
  return [...new Set([externalJobId, bare, ...all.map((provider) => formatSttJobId(provider, bare))])];
}

@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);

  constructor(
    private readonly secrets: SecretsService,
    private readonly soniox: SonioxSttProvider,
    private readonly assemblyai: AssemblyAiSttProvider,
    private readonly elevenlabs: ElevenLabsSttProvider,
  ) {}

  private provider(name: SttProviderName): SttProvider {
    if (name === 'soniox') return this.soniox;
    if (name === 'assemblyai') return this.assemblyai;
    return this.elevenlabs;
  }

  private async apiKey(name: SttProviderName): Promise<string> {
    try {
      return await this.secrets.resolve(CREDENTIAL_REF[name]);
    } catch {
      throw new SttProviderError(name, `ключ ${CREDENTIAL_REF[name]} не задан в окружении`);
    }
  }

  /** Кто возьмёт этот язык — нужно вызывающему коду, чтобы загрузить
   *  аудио ТУДА ЖЕ, куда потом уйдёт задача. */
  providerForLanguage(languageCode?: string | null): SttProviderName {
    return sttProviderForLanguage(languageCode);
  }

  /** Загрузка байтов провайдеру, который затем возьмёт задачу. */
  async uploadAudio(
    audio: ReadableStream<Uint8Array>,
    languageCode?: string | null,
    contentType?: string | null,
  ): Promise<{ audioUrl: string; provider: SttProviderName }> {
    // РЕВЬЮ 2026-09-02: здесь не было ни фоллбека, ни обработки
    // отсутствующего ключа — без SONIOX_API_KEY голосовая реплика
    // падала бы 500 у ВСЕХ, кроме англоязычных, хотя документация
    // обещает «деградируют, а не сломаются». Стрим читается один раз,
    // поэтому для второй попытки его надо сохранить в память — это
    // путь коротких записей (реплика, заметка), длинный разговор
    // грузится напрямую в приватный blob и сюда не приходит.
    const chain = sttFallbackChain(languageCode, 'webhook');
    const failures: string[] = [];
    let buffered: Buffer | null = null;

    for (const name of chain) {
      try {
        const key = await this.apiKey(name);
        if (buffered === null) {
          const chunks: Uint8Array[] = [];
          const reader = audio.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          buffered = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        }
        const audioUrl = await this.provider(name).uploadAudio(
          key,
          new Blob([new Uint8Array(buffered)]).stream(),
          contentType,
        );
        if (failures.length > 0) {
          this.logger.warn(`Аудио принял запасной провайдер ${name}. Основной отказал: ${failures.join('; ')}`);
        }
        return { audioUrl, provider: name };
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new ServiceUnavailableException(
      `Не удалось передать аудио ни одному провайдеру распознавания — ${failures.join('; ')}`,
    );
  }

  /**
   * Длинный файл: задача с вебхуком.
   *
   * `uploadedTo` — провайдер, которому уже отданы байты (результат
   * uploadAudio). Если он задан, фоллбека НЕ БУДЕТ: ссылка на файл
   * внутри одного провайдера другому бесполезна, и молча уйти к
   * соседу — значит отправить его в никуда. Когда байты лежат в нашем
   * приватном хранилище (обычный путь разговора), ссылка публичная и
   * фоллбек работает.
   */
  async submitWebhookJob(params: {
    audioUrl: string;
    webhookUrl: string;
    languageCode?: string | null;
    diarize: boolean;
    uploadedTo?: SttProviderName;
  }): Promise<SttJobRef> {
    const webhookSecret = await resolveSttWebhookSecret(this.secrets);
    if (!webhookSecret) {
      throw new ServiceUnavailableException(
        'Секрет вебхука распознавания не настроен (STT_WEBHOOK_SECRET / ASSEMBLYAI_WEBHOOK_SECRET) — ' +
          'задачу не отправляем: её результат всё равно не прошёл бы проверку и потерялся бы молча',
      );
    }

    const chain = params.uploadedTo
      ? [params.uploadedTo]
      : sttFallbackChain(params.languageCode, 'webhook');

    const failures: string[] = [];
    for (const name of chain) {
      try {
        const { externalJobId } = await this.provider(name).submitWebhookJob(await this.apiKey(name), {
          audioUrl: params.audioUrl,
          webhookUrl: params.webhookUrl,
          languageCode: params.languageCode ?? undefined,
          diarize: params.diarize,
          webhookSecret,
        });
        if (failures.length > 0) {
          this.logger.warn(`Распознавание ушло в запасного провайдера ${name}. Основной отказал: ${failures.join('; ')}`);
        }
        return { provider: name, externalJobId, storedId: formatSttJobId(name, externalJobId) };
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new ServiceUnavailableException(
      `Не удалось поставить задачу распознавания ни одному провайдеру — ${failures.join('; ')}`,
    );
  }

  /** Результат по идентификатору из БД: провайдер определяется по
   *  префиксу, а не по языку — задачу мог взять запасной. */
  async fetchResult(storedId: string): Promise<ParsedTranscript> {
    const { provider, externalJobId } = parseSttJobId(storedId);
    return this.provider(provider).fetchResult(await this.apiKey(provider), externalJobId);
  }

  /**
   * Вебхук пришёл на задачу, владельца которой у нас нет (разговор или
   * реплика удалены до завершения). Результат не нужен — убираем у
   * провайдера, чтобы запись не лежала у него весь retention. Провайдер
   * известен только по форме вебхука (providerHint); без него — ничего.
   * Best-effort: ошибок наружу нет, вебхук всё равно подтверждается.
   */
  async discardOrphan(providerHint: SttProviderName | null, externalJobId: string): Promise<void> {
    if (!providerHint) return;
    const provider = this.provider(providerHint);
    if (!provider.discard) return;
    try {
      await provider.discard(await this.apiKey(providerHint), externalJobId);
    } catch (err) {
      this.logger.warn(`Уборка бесхозной задачи ${providerHint}:${externalJobId} не удалась: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Короткая запись: ответ в том же вызове.
   *
   * Здесь фоллбек работает в полную силу — байты у нас в руках, и
   * второму провайдеру их отдать ничего не стоит. Это и есть «фоллбек
   * для всех — ElevenLabs»: он последний в цепочке для любого языка.
   */
  async transcribeSync(
    audio: Buffer,
    languageCode?: string | null,
  ): Promise<{ text: string; language: string | null; provider: SttProviderName }> {
    const chain = sttFallbackChain(languageCode, 'sync');
    const failures: string[] = [];

    for (const name of chain) {
      try {
        const result = await this.provider(name).transcribeSync(
          await this.apiKey(name),
          audio,
          languageCode ?? undefined,
        );
        if (failures.length > 0) {
          this.logger.warn(`Распознавание заметки выполнил запасной ${name}. Основной отказал: ${failures.join('; ')}`);
        }
        return { ...result, provider: name };
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new ServiceUnavailableException(
      `Не удалось распознать запись ни одним провайдером — ${failures.join('; ')}`,
    );
  }

  /**
   * Ключ для прямого подключения браузера.
   *
   * Фоллбека нет намеренно: соединение устанавливает клиент, и «попробуй
   * другого» — это другой протокол WebSocket, решение клиента, а не
   * наше. Зато провайдер назван в ответе явно, и клиент знает, какой
   * протокол открывать.
   */
  async mintRealtimeToken(
    languageCode: string | null | undefined,
    expiresInSeconds: number,
  ): Promise<SttRealtimeCredentials> {
    const [name] = sttFallbackChain(languageCode, 'realtime');
    const provider = this.provider(name);
    if (!provider.mintRealtimeToken) {
      throw new SttProviderError(name, 'живая полоса этим провайдером не обслуживается');
    }
    return provider.mintRealtimeToken(
      await this.apiKey(name),
      expiresInSeconds,
      sttLanguageHints(languageCode),
    );
  }

}
