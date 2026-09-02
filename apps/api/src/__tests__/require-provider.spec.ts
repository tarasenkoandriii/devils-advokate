// Повторный аудит 2026-09-01. Семь мест читали строку провайдера через
// findUniqueOrThrow: отсутствие строки (сид не прогнан на этой базе)
// давало Prisma P2025, который ApiExceptionFilter не распознаёт, —
// пользователь получал «500 Internal server error» на загрузке записи,
// а настоящая причина («выполните сид») не называлась нигде.
//
// Тот же класс, что и разрыв «код ↔ AIModelCapability»: отсутствие
// строки-конфигурации не должно выглядеть как поломка сервера.
import { ServiceUnavailableException } from '@nestjs/common';
import { requireAIProvider } from '../common/require-provider';

type FakePrisma = Parameters<typeof requireAIProvider>[0];

function fakePrisma(provider: unknown): FakePrisma {
  return { aIProvider: { findUnique: async () => provider } } as unknown as FakePrisma;
}

describe('requireAIProvider', () => {
  it('возвращает провайдера, когда строка есть', async () => {
    const row = { id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' };
    await expect(requireAIProvider(fakePrisma(row), 'assemblyai')).resolves.toBe(row);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: без строки — ServiceUnavailable с указанием на сид, а не 500', async () => {
    await expect(requireAIProvider(fakePrisma(null), 'assemblyai')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    try {
      await requireAIProvider(fakePrisma(null), 'assemblyai');
      throw new Error('должно было бросить');
    } catch (err) {
      const message = (err as ServiceUnavailableException).message;
      expect(message).toContain('assemblyai');
      expect(message).toContain('prisma:seed');
      // Явно сказано, что это конфигурация, а не сбой провайдера —
      // ровно та подмена причины, из-за которой искали не там.
      expect(message).toContain('конфигурация');
    }
  });
});
