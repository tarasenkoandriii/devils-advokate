// Пункт [cascade-took-a-stranger] 2026-09-26, серверная половина.
//
// Экранная — в `apps/tma/src/__tests__`, там разметка РИСУЕТСЯ. Здесь
// проверяется то, что можно проверить только на сервере: что каждая
// цепочка каскада, уносящая чужое, посчитана; что запросы отбирают
// ИМЕННО чужое; что числа снимаются ДО удаления; и что схема всё ещё
// устроена так, как этот пункт описывает, — иначе описание станет
// неправдой молча.

import { PrivacyCenterController } from '../privacy-center/privacy-center.controller';
import {
  DELETION_TAKES_FROM_OTHERS,
  THIRD_PARTY_LOSSES_NOTE,
  thirdPartyLosses,
} from '../privacy-center/deletion-impact';

/** Заглушка Prisma: считает вызовы `count` и отдаёт заданные числа. */
function fakePrisma(answers: Record<string, number>) {
  const seen: Array<{ model: string; where: unknown }> = [];
  const prisma: any = new Proxy(
    {},
    {
      get: (_t, name: string) => ({
        count: (args: any) => {
          seen.push({ model: name, where: args?.where });
          return Promise.resolve(answers[name] ?? 0);
        },
      }),
    },
  );
  return { prisma, seen };
}

describe('Пункт [cascade-took-a-stranger] 2026-09-26: удаление уносит чужое', () => {
  it('проба механизма: реестр последствий непуст и считается заглушкой', async () => {
    expect(DELETION_TAKES_FROM_OTHERS.length).toBe(6);
    const { prisma, seen } = fakePrisma({});
    await thirdPartyLosses(prisma, 'u-1');
    expect(seen.length).toBe(6);
    expect(THIRD_PARTY_LOSSES_NOTE.length).toBeGreaterThan(100);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: посчитаны все три цепочки, названные мерой', async () => {
    const keys = DELETION_TAKES_FROM_OTHERS.map((l) => l.key);
    // Витрина заведений с леджером, библиотека с чужим опытом, публичное
    // обсуждение с чужими словами.
    expect(keys).toEqual([
      'library-experiences',
      'library-entries',
      'venue-bookings',
      'venue-listings',
      'discussion-comments',
      'discussion-submissions',
    ]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отметки о бронировании считаются ЧУЖИЕ, а не свои', async () => {
    const { prisma, seen } = fakePrisma({ venueBookingConfirmation: 3 });
    await thirdPartyLosses(prisma, 'u-СВОЙ');
    const q = seen.find((s) => s.model === 'venueBookingConfirmation');
    const where = JSON.stringify(q!.where);
    // Своя отметка — не «чужое»: считать её значило бы пугать человека
    // его же записью.
    expect(where).toContain('"not":"u-СВОЙ"');
    // И только в заведении, заявку на которое подавал он.
    expect(where).toContain('submittedByUserId');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждый запрос сужен по ЭТОМУ человеку', async () => {
    const { prisma, seen } = fakePrisma({});
    await thirdPartyLosses(prisma, 'u-СВОЙ');
    for (const q of seen) {
      expect(`${q.model}: ${JSON.stringify(q.where)}`).toContain('u-СВОЙ');
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: нули не показываются, непустое показывается', async () => {
    const { prisma } = fakePrisma({ libraryExperience: 2, publicComment: 5 });
    const losses = await thirdPartyLosses(prisma, 'u-1');
    expect(losses.map((l) => l.key)).toEqual(['library-experiences', 'discussion-comments']);
    expect(losses[0].text).toContain('2');
    expect(losses[0].text).toMatch(/ДРУГИМИ людьми/);
    expect(losses[1].text).toContain('5');
  });

  it('обратная проба: когда чужого нет — список пуст, а не строка с нулями', async () => {
    const { prisma } = fakePrisma({});
    expect(await thirdPartyLosses(prisma, 'u-1')).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чтение «до решения» отдаёт те же последствия, что и отчёт после', async () => {
    // Смысл всего пункта в том, что человек видит последствия ДО
    // нажатия. Мутация «отдать пустой список» жила, потому что
    // предупреждение проверялось только на экране, а на сервере — нет.
    const losses = [{ key: 'venue-bookings', count: 4, text: '4 отметок ДРУГИХ людей', why: 'привязаны к карточке' }];
    const controller = new PrivacyCenterController({ thirdPartyLosses: async () => losses } as never);
    const preview = await controller.accountDeletionPreview('u-1');
    expect(preview.takesFromOthers).toEqual(losses);
    expect(preview.takesFromOthersNote).toBe(THIRD_PARTY_LOSSES_NOTE);
  });

  it('обратная проба: пустые последствия доезжают пустыми, а не подменяются', async () => {
    const controller = new PrivacyCenterController({ thirdPartyLosses: async () => [] } as never);
    expect((await controller.accountDeletionPreview('u-1')).takesFromOthers).toEqual([]);
  });

  it('у каждого последствия назван ПУТЬ каскада, а не только факт', () => {
    for (const l of DELETION_TAKES_FROM_OTHERS) {
      expect(l.why.length).toBeGreaterThan(40);
      expect(l.text(7)).toContain('7');
    }
  });

});
