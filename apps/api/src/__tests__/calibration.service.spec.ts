import { CalibrationService } from '../calibration/calibration.service';

// Якоря совпадают с CONFIDENCE_ANCHORS в самом сервисе (ТЗ §4.3: Brier
// score считается против ФИКСИРОВАННЫХ якорей, не против только что
// выведенной calibratedProbability — иначе метрика измеряла бы саму
// себя).
const ANCHORS: Record<string, number> = { LOW: 0.25, MEDIUM: 0.5, HIGH: 0.75 };

function createFakePrisma() {
  const scenarios: any[] = [];
  let idCounter = 0;

  return {
    _seedScenario(s: { confidence: 'LOW' | 'MEDIUM' | 'HIGH'; outcomeConfirmed: boolean | null }) {
      scenarios.push({ id: `s-${++idCounter}`, ...s });
    },
    _all() {
      return scenarios;
    },

    outcomeScenario: {
      findMany: async ({ where, select }: any) => {
        let rows = scenarios;
        if (where?.outcomeConfirmed?.not === null) {
          rows = rows.filter((s) => s.outcomeConfirmed !== null);
        }
        if (!select) return rows.map((r) => ({ ...r }));
        const projected = rows.map((r) => {
          const out: any = {};
          for (const key of Object.keys(select)) out[key] = r[key];
          return out;
        });
        return projected;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const s of scenarios) {
          if (where?.confidence && s.confidence !== where.confidence) continue;
          Object.assign(s, data);
          count++;
        }
        return { count };
      },
    },
  };
}

function makeService(prisma: any) {
  return new CalibrationService(prisma as any);
}

describe('CalibrationService', () => {
  it('acceptance-тест §6.4 (первый сценарий): 25 подтверждённых исходов — gate не пройден, sampleSize честно меньше порога 30', async () => {
    const prisma = createFakePrisma();
    for (let i = 0; i < 25; i++) {
      prisma._seedScenario({ confidence: 'MEDIUM', outcomeConfirmed: i % 2 === 0 });
    }
    const service = makeService(prisma);

    const status = await service.getStatus();

    expect(status.sampleSize).toBe(25);
    expect(status.threshold).toBe(30);
    expect(status.gatePassed).toBe(false);
    expect(status.brierScore).not.toBeNull();
  });

  it('acceptance-тест §6.4 (второй сценарий): 30+ подтверждённых исходов — gate пройден, Brier score считается плановым пересчётом', async () => {
    const prisma = createFakePrisma();
    for (let i = 0; i < 30; i++) {
      prisma._seedScenario({ confidence: 'HIGH', outcomeConfirmed: true });
    }
    const service = makeService(prisma);

    const recomputed = await service.recomputeCalibration();

    expect(recomputed.sampleSize).toBe(30);
    expect(recomputed.gatePassed).toBe(true);
    // Все 30 подтверждены как true при якоре HIGH=0.75 → (0.75-1)^2 = 0.0625 на каждый.
    expect(recomputed.brierScore).toBeCloseTo(0.0625, 5);
  });

  it('Brier score считается против фиксированных якорей (0.25/0.5/0.75), не против только что выведенной calibratedProbability', async () => {
    const prisma = createFakePrisma();
    // Корзина LOW: 10 подтверждённых, 3 из них true → эмпирика 0.3,
    // но якорь для Brier — фиксированный 0.25, не 0.3.
    for (let i = 0; i < 10; i++) {
      prisma._seedScenario({ confidence: 'LOW', outcomeConfirmed: i < 3 });
    }
    const service = makeService(prisma);

    const status = await service.getStatus();

    const expectedBrier =
      (3 * (ANCHORS.LOW - 1) ** 2 + 7 * (ANCHORS.LOW - 0) ** 2) / 10;
    expect(status.brierScore).toBeCloseTo(expectedBrier, 5);
  });

  it('recomputeCalibration пишет эмпирическую точность корзины обратно во ВСЕ сценарии этой корзины, включая ещё неподтверждённые', async () => {
    const prisma = createFakePrisma();
    prisma._seedScenario({ confidence: 'MEDIUM', outcomeConfirmed: true });
    prisma._seedScenario({ confidence: 'MEDIUM', outcomeConfirmed: true });
    prisma._seedScenario({ confidence: 'MEDIUM', outcomeConfirmed: false });
    // Ещё не подтверждённый сценарий той же корзины — должен всё равно
    // получить обновлённую calibratedProbability как лучшую текущую оценку.
    prisma._seedScenario({ confidence: 'MEDIUM', outcomeConfirmed: null });

    const service = makeService(prisma);
    await service.recomputeCalibration();

    const empiricalAccuracy = 2 / 3; // 2 из 3 подтверждённых — true
    for (const s of prisma._all()) {
      expect(s.calibratedProbability).toBeCloseTo(empiricalAccuracy, 5);
    }
  });

  it('корзина без подтверждённых исходов не обновляется (нечего усреднять) и не ломает расчёт по другим корзинам', async () => {
    const prisma = createFakePrisma();
    prisma._seedScenario({ confidence: 'LOW', outcomeConfirmed: true });
    // HIGH-корзина вообще не встречается — recomputeCalibration не должен упасть.

    const service = makeService(prisma);
    const result = await service.recomputeCalibration();

    expect(result.sampleSize).toBe(1);
    expect(result.gatePassed).toBe(false);
  });

  it('getStatus с пустой выборкой честно возвращает brierScore: null, а не NaN/0', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const status = await service.getStatus();

    expect(status.sampleSize).toBe(0);
    expect(status.brierScore).toBeNull();
    expect(status.gatePassed).toBe(false);
  });
});
