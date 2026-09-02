// Пункт [stt-multi] 2026-09-02 — guard вебхуков распознавания речи.
//
// Заменяет AssemblyAiWebhookGuard, потому что провайдеров стало два
// (AssemblyAI для английского, Soniox для русского/украинского), а
// точка приёма результата — одна и та же на оба. Проверка та же:
// секрет, который мы задали при постановке задачи, провайдер возвращает
// нам в заголовке. Fail closed: секрет не настроен → 503, а не «пропустить».
//
// ПОЧЕМУ ДВА ЗАГОЛОВКА. Новые задачи уходят с `x-stt-webhook-secret`.
// Но в момент выката в очереди у AssemblyAI уже висят задачи, созданные
// со СТАРЫМ заголовком `x-assemblyai-webhook-secret`, и их результат
// придёт через минуты или часы. Отвергнуть их — потерять расшифровки
// разговоров, за которые уже заплачено. Поэтому guard принимает оба;
// старый снимать не раньше, чем истечёт самая длинная задача.
//
// ПОЧЕМУ СЕКРЕТ ОДИН. Имя переменной осталось ASSEMBLYAI_WEBHOOK_SECRET:
// это тот же секрет той же точки приёма, и переименование переменной
// окружения стоило бы обязательного шага в деплое ради косметики.
// Новое имя STT_WEBHOOK_SECRET поддержано и имеет приоритет — если
// когда-нибудь захочется развести, менять код не придётся.
import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SecretsService } from '../../secrets/secrets.service';
import { safeSecretEqual } from '../timing-safe-equal';

/** Заголовок, с которым уходят НОВЫЕ задачи (оба провайдера). */
export const STT_WEBHOOK_HEADER = 'x-stt-webhook-secret';
/** Заголовок задач, созданных до этой правки. */
export const LEGACY_ASSEMBLYAI_WEBHOOK_HEADER = 'x-assemblyai-webhook-secret';

export const STT_WEBHOOK_SECRET_REF = 'STT_WEBHOOK_SECRET';
export const LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF = 'ASSEMBLYAI_WEBHOOK_SECRET';

/** Секрет вебхуков распознавания: новое имя, при его отсутствии —
 *  историческое. Один источник для guard и для постановки задач. */
export async function resolveSttWebhookSecret(secrets: SecretsService): Promise<string | null> {
  const preferred = await secrets.resolve(STT_WEBHOOK_SECRET_REF).catch(() => null);
  if (preferred) return preferred;
  return secrets.resolve(LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF).catch(() => null);
}

@Injectable()
export class SttWebhookGuard implements CanActivate {
  constructor(private readonly secrets: SecretsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const expected = await resolveSttWebhookSecret(this.secrets);
    if (!expected) {
      throw new ServiceUnavailableException(
        `${STT_WEBHOOK_SECRET_REF} (или ${LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF}) не настроен — вебхуки транскрипции отключены (fail closed)`,
      );
    }

    const header = (name: string): string | undefined => {
      const raw = req.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    const provided = header(STT_WEBHOOK_HEADER) ?? header(LEGACY_ASSEMBLYAI_WEBHOOK_HEADER);

    if (!provided || !safeSecretEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return true;
  }
}
