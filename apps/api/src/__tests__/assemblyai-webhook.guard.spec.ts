// Полный аудит 2026-08-30 — вебхуки AssemblyAI были без аутентификации.
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AssemblyAiWebhookGuard, ASSEMBLYAI_WEBHOOK_HEADER } from '../common/webhook/assemblyai-webhook.guard';

function ctx(headers: Record<string, string>) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
}
const secrets = (v: string | null) => ({ resolve: async () => v }) as any;

describe('AssemblyAiWebhookGuard', () => {
  it('верный секрет в заголовке — пропуск', async () => {
    const g = new AssemblyAiWebhookGuard(secrets('s3cret'));
    await expect(g.canActivate(ctx({ [ASSEMBLYAI_WEBHOOK_HEADER]: 's3cret' }))).resolves.toBe(true);
  });
  it('нет заголовка или неверный — 401', async () => {
    const g = new AssemblyAiWebhookGuard(secrets('s3cret'));
    await expect(g.canActivate(ctx({}))).rejects.toThrow(UnauthorizedException);
    await expect(g.canActivate(ctx({ [ASSEMBLYAI_WEBHOOK_HEADER]: 'wrong' }))).rejects.toThrow(UnauthorizedException);
    await expect(g.canActivate(ctx({ [ASSEMBLYAI_WEBHOOK_HEADER]: 's3cret-longer' }))).rejects.toThrow(UnauthorizedException);
  });
  it('секрет не настроен — 503 (fail closed), а не пропуск', async () => {
    const g = new AssemblyAiWebhookGuard(secrets(null));
    await expect(g.canActivate(ctx({ [ASSEMBLYAI_WEBHOOK_HEADER]: 'anything' }))).rejects.toThrow(ServiceUnavailableException);
  });
});
