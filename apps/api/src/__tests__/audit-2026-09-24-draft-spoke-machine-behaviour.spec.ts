// Пункт [draft-spoke-machine] 2026-09-24 — поведенческая половина сверки.
//
// ПРАВИЛО. Метод, который возвращает поле `disclaimer`, собирает не
// данные для экрана, а ДОКУМЕНТ: текст, который человек распечатает и
// отнесёт юристу. Значит в его тексте не может стоять машинная
// константа перечисления, и написан он должен быть на языке интерфейса.
//
// Здесь проверяется не то, что в коде упомянут словарь подписей, а то,
// что НИ ОДНО значение перечисления не выходит наружу сырым. Список
// значений берётся из самого перечисления Prisma, а не переписывается
// сюда: добавят в перечисление новую роль и забудут подпись — эта
// сверка упадёт, назвав роль по имени.

import { DtpParticipantRole, FamilyLawPartyRole } from '@prisma/client';
import { DTP_ROLE_LABEL, labelFor } from '../common/document-labels';
import { DtpV2Service } from '../dtp/dtp-v2.service';
import { FamilyLawV2Service } from '../family-law/family-law-v2.service';

const DTP_ROLES = Object.values(DtpParticipantRole) as string[];
const FAMILY_ROLES = Object.values(FamilyLawPartyRole) as string[];

function dtpPrisma(participants: any[]) {
  return {
    dtpConfig: { findUnique: async () => ({ id: 'c1', projectId: 'p1', targetBudget: null, currency: null }) },
    project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
    dtpParticipant: { findMany: async () => participants },
    dtpFaultDetermination: { findMany: async () => [] },
    dtpBudgetLineItem: { findMany: async () => [] },
    dtpConsultation: { findMany: async () => [] },
  } as any;
}

function familyPrisma(parties: any[], assets: any[] = []) {
  return {
    familyLawConfig: { findUnique: async () => ({ id: 'c1', projectId: 'p1', targetBudget: null, currency: null }) },
    project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
    familyLawParty: { findMany: async () => parties },
    familyLawAsset: { findMany: async () => assets },
    familyLawStatusDetermination: { findMany: async () => [] },
    familyLawBudgetLineItem: { findMany: async () => [] },
    familyLawConsultation: { findMany: async () => [] },
  } as any;
}

describe('[draft-spoke-machine] черновик документа говорит словами, а не константами', () => {
  it('черновик ДТП не содержит ни одного сырого значения DtpParticipantRole', async () => {
    const participants = DTP_ROLES.map((role, i) => ({ id: `p${i}`, role, displayName: `Человек ${i}` }));
    const service = new DtpV2Service(dtpPrisma(participants), {} as any);

    const draft = await service.getSettlementProtocolDraft('u1', 'c1');

    const leaked = DTP_ROLES.filter((r) => draft.text.includes(r));
    expect(leaked).toEqual([]);
  });

  it('черновик имущественных условий не содержит ни одного сырого значения FamilyLawPartyRole', async () => {
    const parties = FAMILY_ROLES.map((role, i) => ({ id: `s${i}`, role, displayName: `Сторона ${i}` }));
    const service = new FamilyLawV2Service(familyPrisma(parties), {} as any);

    const draft = await service.getSettlementProtocolDraft('u1', 'c1');

    const leaked = FAMILY_ROLES.filter((r) => draft.text.includes(r));
    expect(leaked).toEqual([]);
  });

  // ОБРАТНАЯ ПРОБА. Если бы подстановка снова пошла сырой, проверка выше
  // обязана это увидеть. Здесь это показано на тексте, собранном по
  // старому правилу: значения перечисления в нём есть, и фильтр их
  // находит. Без этой пробы `toEqual([])` могло бы проходить потому, что
  // список ролей пуст, а не потому, что утечки нет.
  it('обратная проба: фильтр действительно ловит сырую константу', () => {
    const old = `Участники: ${DTP_ROLES[1]} (Иван Петров)`;
    const leaked = DTP_ROLES.filter((r) => old.includes(r));
    expect(leaked).toEqual([DTP_ROLES[1]]);
    expect(DTP_ROLES.length).toBeGreaterThan(1);
    expect(FAMILY_ROLES.length).toBeGreaterThan(1);
  });

  // Имя и свободный текст человека — его слова, они переносятся дословно
  // и НЕ проходят через словарь подписей.
  it('слова человека переносятся в документ дословно', async () => {
    const service = new FamilyLawV2Service(
      familyPrisma(
        [{ id: 's1', role: FamilyLawPartyRole.SPOUSE, displayName: 'Мария Л.' }],
        [{ id: 'a1', assetType: 'дача в Пуще-Водице', estimatedValue: null, currency: null }],
      ),
      {} as any,
    );

    const draft = await service.getSettlementProtocolDraft('u1', 'c1');

    expect(draft.text.includes('Мария Л.')).toBe(true);
    expect(draft.text.includes('дача в Пуще-Водице')).toBe(true);
  });

  // Оговорка — самая важная строка документа: она объясняет человеку,
  // что бумага у него в руках не является юридическим документом.
  // Прочитать её он должен на том же языке, на котором пользуется
  // продуктом.
  // Отдельно — сам словарный помощник. Обе его границы (пустое
  // значение и значение без подписи) в черновиках недостижимы: роль в
  // базе обязательна, а перечисление закрыто. Помощник, однако, общий,
  // и следующий вызов может прийти с необязательным полем — поэтому
  // границы проверяются напрямую, а не через документ, которому их не
  // достать.
  it('labelFor: пустое значение называется словами, неизвестное сохраняется как есть', () => {
    expect(labelFor(DTP_ROLE_LABEL, null)).toBe('не указано');
    expect(labelFor(DTP_ROLE_LABEL, undefined)).toBe('не указано');
    expect(labelFor(DTP_ROLE_LABEL, '')).toBe('не указано');
    expect(labelFor(DTP_ROLE_LABEL, 'WITNESS')).toBe('WITNESS');
    expect(labelFor(DTP_ROLE_LABEL, 'OTHER_PARTY')).toBe('вторая сторона');
  });

  it('оговорка написана на языке интерфейса в обоих черновиках', async () => {
    const dtp = await new DtpV2Service(dtpPrisma([]), {} as any).getSettlementProtocolDraft('u1', 'c1');
    const family = await new FamilyLawV2Service(familyPrisma([]), {} as any).getSettlementProtocolDraft('u1', 'c1');

    for (const disclaimer of [dtp.disclaimer, family.disclaimer]) {
      expect(disclaimer.length).toBeGreaterThan(40);
      // Буквы, которых нет в языке интерфейса: их присутствие означает,
      // что шаблон писали на другом языке.
      expect(/[іїєґ]/i.test(disclaimer)).toBe(false);
      expect(disclaimer.includes('юридически завершённый документ')).toBe(true);
    }
  });
});
