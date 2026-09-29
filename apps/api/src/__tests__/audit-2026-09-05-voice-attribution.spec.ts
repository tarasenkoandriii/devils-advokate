// Сверка 2026-09-05 — чьи это слова, решал некалиброванный порог.
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ. На экране сопровождения продукт сверяет голос
// говорящего с голосовым отпечатком пользователя и по результату решает,
// ЧЬИ реплики уйдут в разбор поведения собеседника — в частности, в
// предупреждение «настойчивый интерес к теме». Порог сравнения в самом
// же файле честно назван неоткалиброванным на реальных голосах.
//
// НАЙДЕННОЕ.
//
//  1. Наружу уходил ОДИН ВЕРДИКТ: `{ isMatch }` — «это вы / это не вы».
//     Ни сходства, ни порога, ни слова о том, что порог не откалиброван.
//     Ошибка порога отправляет в разбор поведения СОБЕСЕДНИКА
//     собственные слова человека.
//  2. Сбой сверки проглатывался пустым `catch(() => {})` в клиенте. Если
//     сверка не отвечает вовсе, ни одна реплика не помечается «моя» — и
//     весь разговор уходит в разбор как речь собеседника. Молча.
//  3. Экран не говорил, что разделение говорящих — догадка. При этом
//     соседний блок на том же экране честно помечен «🟡 догадка ИИ»:
//     правило было, просто не везде.
//
// ЧЕГО СВЕРКА НЕ МЕНЯЕТ. Поведение «нераспознанную реплику включаем в
// разбор» остаётся: в коде оно объяснено — лучше лишний разбор, чем
// потерянный сигнал. Изменилось одно: теперь об этом сказано человеку,
// а не только в комментарии.

import {
  VoiceEmbeddingService,
  cosineSimilarity,
} from '../voice-embedding/voice-embedding.service';

function fakePrisma(embedding: number[] | null) {
  return {
    voiceEmbedding: {
      findUnique: async () => (embedding ? { userId: 'me', embedding, dimension: embedding.length } : null),
    },
  };
}

function service(embedding: number[] | null) {
  return new VoiceEmbeddingService(fakePrisma(embedding) as any, {} as any);
}

describe('Голосовая атрибуция: вердикт не выдаётся за измерение', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: вместе с вердиктом приходит основание', async () => {
    const ref = [1, 0, 0];
    const result = await service(ref).verifyDetailed('me', [1, 0, 0]);
    expect(result.isMatch).toBe(true);
    expect(result.similarity).toBeCloseTo(1);
    expect(result.threshold).toBeGreaterThan(0);
    // Прямо сказано, что порог не откалиброван: это не делает измерение
    // точнее, но перестаёт выдавать его за точное.
    expect(result.calibrated).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: непохожий голос — вердикт с тем же основанием', async () => {
    const result = await service([1, 0, 0]).verifyDetailed('me', [0, 1, 0]);
    expect(result.isMatch).toBe(false);
    expect(result.similarity).toBeCloseTo(0);
    expect(result.calibrated).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сравнивать не с чем — сказано, ПОЧЕМУ, а не просто null', async () => {
    // «null» без причины на экране превращается в «не удалось» без
    // объяснения, и человек не понимает, записать ли эталон.
    const noReference = await service(null).verifyDetailed('me', [1, 0, 0]);
    expect(noReference.isMatch).toBeNull();
    expect(noReference.reason).toMatch(/Эталон голоса не записан/);

    const otherModel = await service([1, 0]).verifyDetailed('me', [1, 0, 0]);
    expect(otherModel.isMatch).toBeNull();
    expect(otherModel.reason).toMatch(/другой моделью/);
    // И сходство не выдумывается там, где сравнения не было.
    expect(otherModel.similarity).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: старый verify() продолжает отвечать тем же — совместимость не сломана', async () => {
    // Метод используется в коде помимо контроллера; менять его смысл
    // заодно значило бы чинить одно и ломать другое.
    expect(await service([1, 0, 0]).verify('me', [1, 0, 0])).toBe(true);
    expect(await service([1, 0, 0]).verify('me', [0, 1, 0])).toBe(false);
    expect(await service(null).verify('me', [1, 0, 0])).toBeNull();
  });

  it('порог применяется как задано, а не как захотелось', async () => {
    const s = service([1, 0, 0]);
    const almost = [0.9, 0.436, 0];
    const sim = cosineSimilarity([1, 0, 0], almost);
    expect((await s.verifyDetailed('me', almost, sim - 0.01)).isMatch).toBe(true);
    expect((await s.verifyDetailed('me', almost, sim + 0.01)).isMatch).toBe(false);
  });
});
