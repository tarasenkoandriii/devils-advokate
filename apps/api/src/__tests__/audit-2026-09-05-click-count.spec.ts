// Сверка 2026-09-05 — доля, которая росла от нажатий.
//
// НАЙДЕННОЕ. Экран показывал про человека строку: «в похожих ситуациях
// 4 из 6 раз вёл себя схожим образом» — вероятностное утверждение О
// ЧЕЛОВЕКЕ. За ним стояли два числа, которых оно не выдерживает:
//
//  1. ЗНАМЕНАТЕЛЬ БЫЛ НЕ О ТОМ. `total` считал ВСЕ строки таблицы по
//     этому человеку — накопленные разными поисками, по разным
//     ситуациям. «Похожие ситуации» в тексте и «всё, что вообще нашли
//     про человека» в числе — разные множества, показанные как одно.
//  2. ЧИСЛИТЕЛЬ РОС ОТ НАЖАТИЙ. Повторный поиск по той же ситуации
//     создавал строки заново: один реальный случай мог попасть в
//     таблицу трижды, трижды посчитаться в доле и трижды занять место в
//     окне последних пяти прецедентов, которое уходит в разборы (пункт
//     [partial-basis]) — вытеснив три настоящих.
//
// ЧЕГО СВЕРКА НЕ ДЕЛАЕТ. Она не объявляет саму долю бессмысленной:
// §3.9 ТЗ прямо просит «вероятностную, а не голословную оценку». Она
// требует, чтобы доля считалась внутри ОДНОЙ ситуации и чтобы рядом
// стояло, что это за доля — часть найденного продуктом, а не часть
// жизни человека.

import { PrecedentSearchService } from '../precedent-search/precedent-search.service';
import { createFakeConsentService } from './fake-consent';

function fakePrisma() {
  const precedents: any[] = [];
  const people = new Map<string, any>();
  let n = 0;
  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedPrecedent(p: any) {
      precedents.push({ id: `pr-${++n}`, createdAt: new Date(2026, 0, n), similarity: 'ANALOGOUS', ...p });
    },
    _precedents() { return precedents; },
    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        return p && p.createdByUserId === where.createdByUserId ? p : null;
      },
    },
    // Поиск прецедентов честно отказывается работать без данных —
    // фейку нужен хотя бы один факт, иначе он проверял бы отказ, а не
    // дедуп.
    personFact: { findMany: async () => [{ id: 'f1', content: 'что-то', sourceType: 'PERSONAL_RECORD' }] },
    conversation: { findMany: async () => [] },
    promptVersion: { findFirst: async () => null },
    behaviorPrecedent: {
      findMany: async ({ where }: any) =>
        precedents
          .filter(
            (p) =>
              p.personId === where.personId &&
              (where.situationDescription === undefined || p.situationDescription === where.situationDescription),
          )
          .sort((a, b) => b.createdAt - a.createdAt),
      create: async ({ data }: any) => {
        const p = { id: `pr-${++n}`, createdAt: new Date(2026, 5, n), ...data };
        precedents.push(p);
        return p;
      },
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
    // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: под замком
    // счётчика расходов идёт сырой запрос — заглушка обязана знать и его.
    $executeRaw: async () => 1,
  };
}

class FakeRouter {
  responseText = '[]';
  lastRequest: any = null;
  async execute(req: any) {
    this.lastRequest = req;
    return { text: this.responseText, aiInferenceId: 'inf-1', jobId: 'job-1' };
  }
}

function setup() {
  const prisma = fakePrisma();
  prisma._seedPerson({ id: 'p1', createdByUserId: 'me' });
  const router = new FakeRouter();
  return { prisma, router, service: new PrecedentSearchService(prisma as any, router as any, createFakeConsentService() as any) };
}

describe('Доля о человеке не растёт от нажатий', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: повторный поиск не создаёт запись заново', async () => {
    const s = setup();
    s.router.responseText = JSON.stringify([
      { precedentDescription: 'В марте отказал без объяснений', similarity: 'ANALOGOUS', sourceDescription: 'разговор 3 марта' },
    ]);

    const first = await s.service.findPrecedents('me', 'p1', 'просьба о повышении');
    expect(first.created).toHaveLength(1);
    expect(first.duplicatesSkipped).toBe(0);

    const second = await s.service.findPrecedents('me', 'p1', 'просьба о повышении');
    expect(second.created).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(s.prisma._precedents()).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: повтор узнаётся с точностью до регистра и пробелов', async () => {
    // Модель на повторном запуске возвращает ту же мысль с точностью до
    // регистра и пробела. Считать это разными случаями — самообман.
    const s = setup();
    s.router.responseText = JSON.stringify([
      { precedentDescription: 'В марте отказал', similarity: 'ANALOGOUS', sourceDescription: 'x' },
    ]);
    await s.service.findPrecedents('me', 'p1', 'ситуация');
    s.router.responseText = JSON.stringify([
      { precedentDescription: '  в марте отказал  ', similarity: 'ANALOGOUS', sourceDescription: 'x' },
    ]);
    const again = await s.service.findPrecedents('me', 'p1', 'ситуация');
    expect(again.duplicatesSkipped).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: тот же текст для ДРУГОЙ ситуации — не повтор', async () => {
    // Обратная половина: один и тот же случай может быть прецедентом для
    // двух разных ситуаций, и склеивать их значит терять то, что человек
    // искал.
    const s = setup();
    s.router.responseText = JSON.stringify([
      { precedentDescription: 'В марте отказал', similarity: 'ANALOGOUS', sourceDescription: 'x' },
    ]);
    await s.service.findPrecedents('me', 'p1', 'ситуация А');
    const other = await s.service.findPrecedents('me', 'p1', 'ситуация Б');
    expect(other.created).toHaveLength(1);
    expect(other.duplicatesSkipped).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: доля считается ВНУТРИ ситуации, а не по всей таблице', async () => {
    const s = setup();
    // Три прецедента по старой ситуации и два по свежей.
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'старое', similarity: 'ANALOGOUS', precedentDescription: 'a' });
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'старое', similarity: 'ANALOGOUS', precedentDescription: 'b' });
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'старое', similarity: 'CONTRASTING', precedentDescription: 'c' });
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'свежее', similarity: 'ANALOGOUS', precedentDescription: 'd' });
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'свежее', similarity: 'CONTRASTING', precedentDescription: 'e' });

    const view = await s.service.list('me', 'p1');
    expect(view.situation).toBe('свежее');
    expect(view.situationTotal).toBe(2);
    expect(view.situationAnalogousCount).toBe(1);
    // Общее число не исчезло — но и не выдаётся за долю.
    expect(view.total).toBe(5);
    expect(view.conclusion).toMatch(/складывать их в одну долю нельзя/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сказано, ЧТО это за доля — иначе она читается как доля жизни человека', async () => {
    const s = setup();
    s.prisma._seedPrecedent({ personId: 'p1', situationDescription: 'ситуация', precedentDescription: 'a' });
    const view = await s.service.list('me', 'p1');
    expect(view.conclusion).toMatch(/доля среди НАЙДЕННОГО/);
    expect(view.conclusion).toMatch(/не доля случаев в жизни человека/);
    expect(view.conclusion).toMatch(/не знает, сколько раз бывало иначе/);
    // Прежняя формулировка была утверждением о поведении человека.
    expect(view.conclusion).not.toMatch(/вёл себя схожим образом/);
  });

  it('пусто — сказано «не найдено», без доли и без выводов', async () => {
    const s = setup();
    const view = await s.service.list('me', 'p1');
    expect(view.conclusion).toBe('Прецедентов пока не найдено.');
    expect(view.situation).toBeNull();
  });
});
