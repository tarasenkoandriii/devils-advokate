// Полный аудит 2026-08-30 — вебхуки AssemblyAI (conversations / sparring /
// material-chat) принимали payload с текстом транскрипта БЕЗ какой-либо
// аутентификации: зная id задачи (externalTranscriptionJobId), можно было
// подложить пользователю фальшивый транскрипт, который дальше уходит в
// детекторы манипуляций, факты о людях и аргументы.
//
// AssemblyAI поддерживает webhook_auth_header_name/value при создании
// задачи — сюда он присылает секрет обратно в заголовке. Тот же класс
// решения, что x-dispatch-secret у internal/reminders, только секрет
// задаётся при отправке задачи (TranscriptionService.submitJob) и
// проверяется здесь. Fail closed: секрет не настроен → 503, а не «пропустить».
import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SecretsService } from '../../secrets/secrets.service';
import { safeSecretEqual } from '../timing-safe-equal';

export const ASSEMBLYAI_WEBHOOK_SECRET_REF = 'ASSEMBLYAI_WEBHOOK_SECRET';
export const ASSEMBLYAI_WEBHOOK_HEADER = 'x-assemblyai-webhook-secret';

// Повторный аудит 2026-08-30: локальная копия заменена общим хелпером
// (common/timing-safe-equal.ts) — та же проверка теперь нужна ещё в
// трёх контроллерах, и две реализации одного сравнения секретов
// разъезжаются ровно так же, как разъехались проверки согласий.
const safeEqual = safeSecretEqual;

@Injectable()
export class AssemblyAiWebhookGuard implements CanActivate {
  constructor(private readonly secrets: SecretsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const expected = await this.secrets.resolve(ASSEMBLYAI_WEBHOOK_SECRET_REF).catch(() => null);
    if (!expected) {
      throw new ServiceUnavailableException(`${ASSEMBLYAI_WEBHOOK_SECRET_REF} не настроен — вебхуки транскрипции отключены (fail closed)`);
    }
    const raw = req.headers[ASSEMBLYAI_WEBHOOK_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return true;
  }
}
