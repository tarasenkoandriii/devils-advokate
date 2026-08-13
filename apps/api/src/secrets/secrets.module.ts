// Чекпоинт 1, пункт 12: SecretsModule
//
// Выбор реализации SecretProvider через SECRET_PROVIDER_TYPE в конфиге.
// По умолчанию "env" — рабочий провайдер прямо сейчас. "managed" —
// заготовка (ManagedSecretProvider), намеренно бросает ошибку при
// использовании, пока не реализована реальная интеграция (см. комментарий
// в managed-secret-provider.ts). Смена типа провайдера — одна переменная
// окружения, без изменений в потребителях SecretsService.

import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SECRET_PROVIDER } from './secret-provider.interface';
import { EnvSecretProvider } from './env-secret-provider';
import { ManagedSecretProvider } from './managed-secret-provider';
import { SecretsService } from './secrets.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    EnvSecretProvider,
    ManagedSecretProvider,
    {
      provide: SECRET_PROVIDER,
      inject: [ConfigService, EnvSecretProvider, ManagedSecretProvider],
      useFactory: (
        config: ConfigService,
        envProvider: EnvSecretProvider,
        managedProvider: ManagedSecretProvider,
      ) => {
        const type = config.get<string>('SECRET_PROVIDER_TYPE', 'env');
        switch (type) {
          case 'env':
            return envProvider;
          case 'managed':
            return managedProvider;
          default:
            throw new Error(
              `Unknown SECRET_PROVIDER_TYPE="${type}" — expected "env" or "managed"`,
            );
        }
      },
    },
    SecretsService,
  ],
  exports: [SecretsService],
})
export class SecretsModule {}
