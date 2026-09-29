// Пункт [budget-invented-a-currency] 2026-09-24 — поведенческая половина.
//
// НАЙДЕННОЕ. Правило «смешивать валюты в одном числе нельзя» записано в
// `common/money.ts` ещё аудитом денег 2026-09-03, снабжено помощником
// (`sumByCurrency`, `normalizeCurrency`) и СВОИМИ ТЕСТАМИ. Применялось
// оно в одном месте из четырёх. Три домена — ДТП, семейное право,
// здоровье — считали бюджет каждый сам и одинаково неверно:
//
//     const key = item.currency ?? 'UNSPECIFIED';
//
// 1. `null` у строки значит «валюта проекта», а не «валюты нет». Такие
//    строки уходили в ОТДЕЛЬНУЮ корзину, то есть итог в валюте проекта
//    занижался — и экран говорил «в пределах целевого бюджета» тому,
//    кто уже за него вышел.
// 2. Регистр не приводился: «usd» и «USD» — две валюты.
// 3. Слово `UNSPECIFIED` выходило наружу как код валюты: на экран и в
//    черновик документа для юриста.
//
// Здесь проверяется ПОВЕДЕНИЕ всех трёх расчётов, а не упоминание
// помощника в исходнике: сервис, переставший делегировать, обязан
// уронить эти сценарии, как бы ни выглядели его импорты.

import { DtpV2Service } from '../dtp/dtp-v2.service';
import { FamilyLawV2Service } from '../family-law/family-law-v2.service';
import { HealthV2Service } from '../health/health-v2.service';
import { budgetByCurrency, compareToTarget, moneyWithCurrency } from '../common/money';

type Row = { amount: number; currency: string | null; direction: 'EXPENSE' | 'COVERAGE' };

function prismaFor(configModel: string, itemModel: string, consultationModel: string) {
  return (rows: Row[], config: { currency: string | null; targetBudget: number | null }, written?: any[]) =>
    ({
      [configModel]: { findUnique: async () => ({ id: 'c1', projectId: 'p1', ...config }) },
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
      [itemModel]: {
        findMany: async () => rows,
        create: async ({ data }: any) => {
          written?.push(data);
          return { id: 'l1', ...data };
        },
      },
      [consultationModel]: { findMany: async () => [] },
    }) as any;
}

const DOMAINS = [
  {
    name: 'ДТП',
    category: 'REPAIR',
    build: (rows: Row[], config: any, written?: any[]) =>
      new DtpV2Service(prismaFor('dtpConfig', 'dtpBudgetLineItem', 'dtpConsultation')(rows, config, written), {} as any),
  },
  {
    name: 'семейное право',
    category: 'LEGAL_FEES',
    build: (rows: Row[], config: any, written?: any[]) =>
      new FamilyLawV2Service(
        prismaFor('familyLawConfig', 'familyLawBudgetLineItem', 'familyLawConsultation')(rows, config, written),
        {} as any,
      ),
  },
  {
    name: 'здоровье',
    category: 'PROCEDURE_COST',
    build: (rows: Row[], config: any, written?: any[]) =>
      new HealthV2Service(prismaFor('healthConfig', 'healthBudgetLineItem', 'healthConsultation')(rows, config, written)),
  },
];

describe('[budget-invented-a-currency] бюджет не выдумывает валюту', () => {
  describe.each(DOMAINS)('$name', ({ build, category }) => {
    it('КЛЮЧЕВОЙ ТЕСТ: строка без своей валюты относится к валюте проекта, а не в отдельную корзину', async () => {
      const service = build(
        [
          { amount: 1000, currency: null, direction: 'EXPENSE' },
          { amount: 500, currency: 'UAH', direction: 'EXPENSE' },
        ],
        { currency: 'UAH', targetBudget: null },
      );

      const budget = await service.getBudget('u1', 'c1');

      expect(budget.byCurrency).toHaveLength(1);
      expect(budget.byCurrency[0].currency).toBe('UAH');
      expect(budget.byCurrency[0].netBudget).toBe(1500);
    });

    it('регистр и пробелы в коде валюты не создают вторую валюту', async () => {
      const service = build(
        [
          { amount: 10, currency: 'usd', direction: 'EXPENSE' },
          { amount: 20, currency: ' USD ', direction: 'EXPENSE' },
        ],
        { currency: null, targetBudget: null },
      );

      const budget = await service.getBudget('u1', 'c1');

      expect(budget.byCurrency).toHaveLength(1);
      expect(budget.byCurrency[0].currency).toBe('USD');
      expect(budget.byCurrency[0].netBudget).toBe(30);
    });

    it('когда валюта не указана нигде — это null, а не слово, похожее на код валюты', async () => {
      const service = build([{ amount: 42, currency: null, direction: 'EXPENSE' }], {
        currency: null,
        targetBudget: null,
      });

      const budget = await service.getBudget('u1', 'c1');

      expect(budget.byCurrency).toHaveLength(1);
      expect(budget.byCurrency[0].currency).toBeNull();
    });

    // Нормализация применялась на ПРЕЖНЕМ денежном поле (валюта
    // консультации) и не применялась на том, которое его заменило.
    // Правило чтения теперь приводит код само, но записанное значение
    // видно и отдельной строкой в таблице расходов — там «usd» и
    // осталось бы «usd».
    it('записанная валюта приводится к коду при создании строки бюджета', async () => {
      const written: any[] = [];
      const service = build([], { currency: null, targetBudget: null }, written);

      await service.createBudgetLineItem('u1', 'c1', category, 'EXPENSE', 100, '  usd  ');

      expect(written).toHaveLength(1);
      expect(written[0].currency).toBe('USD');
    });

    it('валюта, не похожая на код, не записывается как код', async () => {
      const written: any[] = [];
      const service = build([], { currency: null, targetBudget: null }, written);

      await service.createBudgetLineItem('u1', 'c1', category, 'EXPENSE', 100, 'гривна');

      expect(written[0].currency).toBeNull();
    });

    it('превышение цели считается на сервере и только в валюте цели', async () => {
      const service = build(
        [
          { amount: 5000, currency: 'UAH', direction: 'EXPENSE' },
          { amount: 5000, currency: 'USD', direction: 'EXPENSE' },
        ],
        { currency: 'UAH', targetBudget: 1000 },
      );

      const budget = await service.getBudget('u1', 'c1');
      const uah = budget.byCurrency.find((b: any) => b.currency === 'UAH');
      const usd = budget.byCurrency.find((b: any) => b.currency === 'USD');

      expect(uah!.targetComparison).toBe('over');
      // Цель в гривне; доллары с ней не сравниваются — и молчать об
      // этом нельзя, молчание читается как «уложились».
      expect(usd!.targetComparison).toBe('not-comparable');
    });
  });

  // ─── Сам общий расчёт ───

  it('покрытие вычитается из расхода внутри своей валюты, а не между валютами', () => {
    const buckets = budgetByCurrency(
      [
        { amount: 1000, currency: 'UAH', direction: 'EXPENSE' },
        { amount: 400, currency: 'UAH', direction: 'COVERAGE' },
        { amount: 100, currency: 'USD', direction: 'COVERAGE' },
      ],
      'UAH',
      null,
    );

    const uah = buckets.find((b) => b.currency === 'UAH')!;
    const usd = buckets.find((b) => b.currency === 'USD')!;
    expect(uah.netBudget).toBe(600);
    expect(usd.netBudget).toBe(-100);
  });

  // Валюта ПРОЕКТА приходит из формы и из разбора модели и так же
  // может быть записана как угодно. Нормализуется она отдельной
  // строкой, и та строка мутацию переживала: ни один сценарий не
  // задавал валюту проекта в нижнем регистре.
  it('валюта проекта тоже приводится к коду, иначе «uah» и «UAH» — две корзины', () => {
    const buckets = budgetByCurrency(
      [
        { amount: 100, currency: null, direction: 'EXPENSE' },
        { amount: 50, currency: 'UAH', direction: 'EXPENSE' },
      ],
      'uah',
      null,
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].currency).toBe('UAH');
    expect(buckets[0].netBudget).toBe(150);
  });

  it('сумма для человека называет отсутствие валюты словами, а не печатает пустоту', () => {
    expect(moneyWithCurrency(1200, 'UAH')).toBe('1200 UAH');
    expect(moneyWithCurrency(1200, null)).toBe('1200 (валюта не указана)');
  });

  it('незаданная цель — «не с чем сравнивать», а не «уложились»', () => {
    expect(compareToTarget(999999, null, 'UAH', 'UAH')).toBe('not-comparable');
    expect(compareToTarget(1, 10, null, null)).toBe('within');
    expect(compareToTarget(11, 10, null, null)).toBe('over');
  });

  // Прежде сравнение считал экран, и при незаданной валюте проекта его
  // условие `b.currency === (data.currency ?? b.currency)` было истинным
  // ВСЕГДА: цель без валюты сравнивалась с корзиной любой валюты.
  it('цель без валюты не сравнивается с корзиной, у которой валюта есть', () => {
    expect(compareToTarget(5000, 10, 'USD', null)).toBe('not-comparable');
  });

  it('цель в одной валюте не сравнивается с корзиной без валюты', () => {
    expect(compareToTarget(5000, 10, null, 'UAH')).toBe('not-comparable');
  });
});
