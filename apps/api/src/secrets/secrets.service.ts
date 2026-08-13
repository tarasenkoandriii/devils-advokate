// Чекпоинт 1, пункт 12: SecretsService — единственная точка, через
// которую остальной код резолвит credentialRef → значение секрета.
// Кэш in-memory с TTL — чтобы не дёргать secret manager на каждый
// AI-вызов (это была бы лишняя сетевая задержка на каждый AIJob).
// TTL, а не бессрочный кэш — чтобы отозванный/сменённый секрет не
// продолжал использоваться неограниченно долго после ротации.

import { Inject, Injectable } from '@nestjs/common';
import { SECRET_PROVIDER, SecretProvider } from './secret-provider.interface';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class SecretsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    @Inject(SECRET_PROVIDER) private readonly provider: SecretProvider,
    ttlMs = 5 * 60 * 1000, // 5 минут по умолчанию
  ) {
    this.ttlMs = ttlMs;
  }

  async resolve(credentialRef: string): Promise<string> {
    const cached = this.cache.get(credentialRef);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.provider.resolve(credentialRef);
    this.cache.set(credentialRef, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  /** Принудительно сбросить кэш для конкретного секрета — например
   * сразу после ротации ключа, не дожидаясь истечения TTL. */
  invalidate(credentialRef: string): void {
    this.cache.delete(credentialRef);
  }

  /** Сброс всего кэша — используется редко (например при массовой
   * ротации всех ключей провайдера). */
  invalidateAll(): void {
    this.cache.clear();
  }
}
