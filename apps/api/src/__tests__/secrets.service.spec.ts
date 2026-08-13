import { SecretsService } from '../secrets/secrets.service';
import { SecretProvider } from '../secrets/secret-provider.interface';

describe('SecretsService', () => {
  it('резолвит через провайдер и кэширует повторный вызов', async () => {
    let callCount = 0;
    const provider: SecretProvider = {
      resolve: async (ref) => {
        callCount++;
        return `resolved-${ref}`;
      },
    };
    const service = new SecretsService(provider, 60_000);

    const first = await service.resolve('OPENAI_API_KEY');
    const second = await service.resolve('OPENAI_API_KEY');

    expect(first).toBe('resolved-OPENAI_API_KEY');
    expect(second).toBe('resolved-OPENAI_API_KEY');
    expect(callCount).toBe(1); // второй вызов — из кэша, провайдер не дёргается снова
  });

  it('после invalidate() резолвит заново через провайдер', async () => {
    let callCount = 0;
    const provider: SecretProvider = {
      resolve: async () => {
        callCount++;
        return `value-${callCount}`;
      },
    };
    const service = new SecretsService(provider, 60_000);

    const first = await service.resolve('KEY');
    service.invalidate('KEY');
    const second = await service.resolve('KEY');

    expect(first).toBe('value-1');
    expect(second).toBe('value-2');
    expect(callCount).toBe(2);
  });

  it('после истечения TTL резолвит заново', async () => {
    let callCount = 0;
    const provider: SecretProvider = {
      resolve: async () => {
        callCount++;
        return `value-${callCount}`;
      },
    };
    const service = new SecretsService(provider, 10); // TTL 10мс

    const first = await service.resolve('KEY');
    await new Promise((r) => setTimeout(r, 20));
    const second = await service.resolve('KEY');

    expect(first).toBe('value-1');
    expect(second).toBe('value-2');
  });

  it('пробрасывает ошибку провайдера, не глотает молча', async () => {
    const provider: SecretProvider = {
      resolve: async () => {
        throw new Error('secret not found');
      },
    };
    const service = new SecretsService(provider, 60_000);

    await expect(service.resolve('MISSING')).rejects.toThrow('secret not found');
  });
});
