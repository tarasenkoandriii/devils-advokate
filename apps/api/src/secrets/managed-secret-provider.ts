// Чекпоинт 1, пункт 12: заготовка провайдера для выделенного secret
// manager. НЕ является рабочей интеграцией — это контракт/заглушка,
// потому что: (а) в среде, где писался этот код, нет сети для установки
// реального клиента (node-vault / @aws-sdk/client-secrets-manager /
// doppler-sdk — какой именно не установить без npm install из
// публичного реестра); (б) выбор конкретного secret manager ещё не
// сделан — решение зависит от того, куда в итоге деплоится API
// (Vercel Hobby → скорее всего просто encrypted env, отдельный Vault
// может быть избыточен для соло-проекта на старте).
//
// Честно оставляю это НЕ готовым, а не притворяюсь рабочей интеграцией
// с пустым телом функции — throw ниже специально бросает понятную
// ошибку, а не молча возвращает пустую строку, если кто-то подключит
// этот провайдер раньше, чем он реально реализован.
//
// Когда решение принято — реализация сводится к: установить SDK,
// заменить throw на реальный вызов клиента, обновить SecretsModule
// (secrets.module.ts) на выбор этого провайдера через SECRET_PROVIDER_TYPE.
// Интерфейс SecretProvider не меняется, значит и все потребители
// (AIRouterService и т.д.) не меняются вообще.

import { Injectable } from '@nestjs/common';
import { SecretProvider } from './secret-provider.interface';

export class SecretProviderNotImplementedError extends Error {
  constructor(providerName: string) {
    super(
      `${providerName} is a scaffold, not a working integration yet. ` +
        `See src/secrets/managed-secret-provider.ts for what's needed before using it.`,
    );
    this.name = 'SecretProviderNotImplementedError';
  }
}

@Injectable()
export class ManagedSecretProvider implements SecretProvider {
  async resolve(_credentialRef: string): Promise<string> {
    throw new SecretProviderNotImplementedError('ManagedSecretProvider');
  }
}
