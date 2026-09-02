// Полный аудит 2026-08-30 — вебхуки распознавания были без аутентификации.
// Пункт [stt-multi] 2026-09-02 — guard стал общим на двух провайдеров
// (AssemblyAI для английского, Soniox для русского/украинского) и
// принимает ДВА заголовка: новый и тот, с которым уже уехали задачи,
// висящие в очереди на момент выката.
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  SttWebhookGuard,
  STT_WEBHOOK_HEADER,
  LEGACY_ASSEMBLYAI_WEBHOOK_HEADER,
  STT_WEBHOOK_SECRET_REF,
  LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF,
} from '../common/webhook/stt-webhook.guard';

function ctx(headers: Record<string, string>) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
}

/** Секрет по ссылке: новое имя приоритетнее исторического. */
const secrets = (values: Record<string, string | null>) =>
  ({
    resolve: async (ref: string) => {
      const value = values[ref];
      if (!value) throw new Error(`нет секрета ${ref}`);
      return value;
    },
  }) as any;

describe('SttWebhookGuard', () => {
  it('верный секрет в НОВОМ заголовке — пропуск', async () => {
    const g = new SttWebhookGuard(secrets({ [STT_WEBHOOK_SECRET_REF]: 's3cret' }));
    await expect(g.canActivate(ctx({ [STT_WEBHOOK_HEADER]: 's3cret' }))).resolves.toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: старый заголовок принимается — иначе теряются задачи, уехавшие до выката', async () => {
    // Задача AssemblyAI живёт в очереди часами; её вебхук придёт со
    // СТАРЫМ именем заголовка. Отвергнуть — значит потерять уже
    // оплаченную расшифровку разговора.
    const g = new SttWebhookGuard(secrets({ [LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF]: 's3cret' }));
    await expect(g.canActivate(ctx({ [LEGACY_ASSEMBLYAI_WEBHOOK_HEADER]: 's3cret' }))).resolves.toBe(true);
  });

  it('историческое имя переменной работает как раньше — переименование не требуется в деплое', async () => {
    const g = new SttWebhookGuard(secrets({ [LEGACY_ASSEMBLYAI_WEBHOOK_SECRET_REF]: 's3cret' }));
    await expect(g.canActivate(ctx({ [STT_WEBHOOK_HEADER]: 's3cret' }))).resolves.toBe(true);
  });

  it('нет заголовка или неверный — 401', async () => {
    const g = new SttWebhookGuard(secrets({ [STT_WEBHOOK_SECRET_REF]: 's3cret' }));
    await expect(g.canActivate(ctx({}))).rejects.toThrow(UnauthorizedException);
    await expect(g.canActivate(ctx({ [STT_WEBHOOK_HEADER]: 'wrong' }))).rejects.toThrow(UnauthorizedException);
    await expect(g.canActivate(ctx({ [STT_WEBHOOK_HEADER]: 's3cret-longer' }))).rejects.toThrow(UnauthorizedException);
  });

  it('секрет не настроен — 503 (fail closed), а не пропуск', async () => {
    const g = new SttWebhookGuard(secrets({}));
    await expect(g.canActivate(ctx({ [STT_WEBHOOK_HEADER]: 'anything' }))).rejects.toThrow(ServiceUnavailableException);
  });
});
