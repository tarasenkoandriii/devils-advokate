// Чекпоинт 1, пункт 12: EnvSecretProvider — реализация SecretProvider
// поверх process.env. Годится для dev/staging и для Vercel encrypted
// env vars в проде (Vercel хранит env переменные шифрованными и не
// светит их в билд-логах — для соло-проекта на Vercel Hobby этого
// достаточно как первый прод-контур, не обязательно сразу поднимать
// отдельный Vault). Если/когда появится выделенный secret manager
// (Vault/AWS Secrets Manager/Doppler) — меняется только выбор
// провайдера в SecretsModule (см. secrets.module.ts), интерфейс
// SecretProvider остаётся тем же, потребители (AIRouterService и т.д.)
// не меняются вообще.

import { Injectable, Logger } from '@nestjs/common';
import { SecretProvider } from './secret-provider.interface';

@Injectable()
export class EnvSecretProvider implements SecretProvider {
  private readonly logger = new Logger(EnvSecretProvider.name);

  async resolve(credentialRef: string): Promise<string> {
    const value = process.env[credentialRef];
    if (!value) {
      this.logger.error(`Secret not found for credentialRef="${credentialRef}"`);
      throw new Error(`Secret not found for credentialRef="${credentialRef}"`);
    }
    return value;
  }
}
