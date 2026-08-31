// Чекпоинт 1, пункт 12: SecretsService — единственная точка, через
// которую остальной код резолвит credentialRef → значение секрета.
// Кэш in-memory с TTL — чтобы не дёргать secret manager на каждый
// AI-вызов (это была бы лишняя сетевая задержка на каждый AIJob).
// TTL, а не бессрочный кэш — чтобы отозванный/сменённый секрет не
// продолжал использоваться неограниченно долго после ротации.

import { Inject, Injectable, Optional } from '@nestjs/common';
import { SECRET_PROVIDER, SecretProvider } from './secret-provider.interface';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** TTL кэша секретов по умолчанию — 5 минут. Вынесен в константу, а не
 * оставлен значением параметра по умолчанию: см. объяснение ниже. */
export const DEFAULT_SECRETS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Токен для переопределения TTL через DI (в продакшн-конфигурации не
 * задаётся — работает значение по умолчанию). Нужен, чтобы второй
 * параметр конструктора был ЯВНО опциональной DI-зависимостью, а не
 * «просто числом с дефолтом». */
export const SECRETS_CACHE_TTL_MS = Symbol('SECRETS_CACHE_TTL_MS');

@Injectable()
export class SecretsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  // ══════════════════════════════════════════════════════════════════
  // ПОЧЕМУ ЗДЕСЬ @Optional() @Inject(), А НЕ ПРОСТО `ttlMs = 5 * 60 * 1000`
  //
  // Прежняя сигнатура — `ttlMs = 5 * 60 * 1000` без аннотации типа —
  // роняла ВСЁ приложение на старте, в любой среде, где TypeScript
  // компилируется с emitDecoratorMetadata (то есть везде: nest build,
  // nest start, Docker, Vercel):
  //
  //   Nest can't resolve dependencies of the SecretsService
  //   (Symbol(SECRET_PROVIDER), ?). Please make sure that the argument
  //   Object at index [1] is available in the SecretsModule context.
  //
  // Механика: tsc эмитит design:paramtypes для каждого параметра
  // конструктора класса с декоратором. Для параметра БЕЗ аннотации типа
  // (тип выведен из инициализатора) эмитится `Object`. Nest читает эти
  // метаданные как список зависимостей — значение по умолчанию из
  // сигнатуры он не видит вообще — и честно пытается найти в контейнере
  // провайдер с токеном `Object`. Такого нет ни в одном модуле, и
  // bootstrap падает ещё до маршрутизации: не 500 на одном эндпоинте, а
  // неподнимающееся приложение целиком.
  //
  // Юнит-тесты этого не ловили и поймать не могли: они создают сервис
  // напрямую (`new SecretsService(provider, 60_000)`), минуя DI-контейнер.
  // Поймал только реальный запуск.
  // ══════════════════════════════════════════════════════════════════
  constructor(
    @Inject(SECRET_PROVIDER) private readonly provider: SecretProvider,
    @Optional() @Inject(SECRETS_CACHE_TTL_MS) ttlMs?: number,
  ) {
    this.ttlMs = ttlMs ?? DEFAULT_SECRETS_CACHE_TTL_MS;
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
