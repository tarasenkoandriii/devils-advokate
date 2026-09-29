// Сверка 2026-09-06 — число, которое называло себя откалиброванным.
//
// НАЙДЕННОЕ. `CalibrationService.recomputeCalibration()` записывал
// `calibratedProbability = confirmed / total` в любую корзину
// уверенности, где нашёлся хотя бы ОДИН подтверждённый исход. Один
// клик человека на «сбылось» — и все сценарии этой корзины получали
// «эмпирическую точность» 1.000.
//
// Это не пробел в ТЗ, а невыполненное требование, записанное буквально
// в трёх местах: ТЗ §4.3 («calibratedProbability не активируется, пока
// датасет исходов меньше минимального размера выборки; стартовое
// значение — 30 предсказаний с известным исходом»), implementation-ready.md
// («calibratedProbability: nullable») и комментарий над самим полем в
// schema.prisma («NULL до накопления достаточной выборки — не "низкая
// вероятность", а буквально "ещё не откалибровано"»). Порог в коде
// тоже был — MIN_SAMPLE_SIZE = 30 — но держал только показ статуса на
// операторском экране, не запись числа.
//
// Форма: ПРОБЕЛ ВЫГЛЯДИТ КАК ПОЛНОТА. По самому числу отличить
// «посчитано по сорока исходам» от «посчитано по одному» нельзя, а
// NULL в этом поле означает «ещё не откалибровано» — значит любое
// не-NULL читается как «откалибровано».
//
// ЧТО ЕЩЁ НАШЛОСЬ РЯДОМ, на операторском экране:
//  • описание gate было неверным («проходит при score ниже порога» —
//    на самом деле при размере выборки не меньше порога; числового
//    порога для Brier score нет ни в коде, ни в ТЗ);
//  • бейдж «не пройден» показывался при `sampleSize > 0`, то есть при
//    единственном исходе оператор читал «измерили и не сошлось» вместо
//    «мерить пока не на чем».
//
// ЧТО НЕ ЧИНИЛОСЬ И ПОЧЕМУ. `gatePassed` оставлен буквально по ТЗ — по
// всей выборке; acceptance-тесты §6.4 держат его как был. Порог НА
// КОРЗИНУ (сверх буквы ТЗ) — решение этой ревизии с названной ценой:
// калибровка активируется позже, чем при пороге по всей выборке. Цена
// принята, потому что число уходит в поле, чей NULL прямо
// документирован как «ещё не откалибровано», и потому что экран
// теперь показывает выборку каждой корзины — задержка видна, а не
// молчалива. Обоснование целиком — в bucket-calibration.ts.

import {
  bucketCalibration,
  bucketCalibrationNote,
  MIN_BUCKET_SAMPLE_SIZE,
} from '../calibration/bucket-calibration';
import { CalibrationService } from '../calibration/calibration.service';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

function createFakePrisma() {
  const scenarios: any[] = [];
  let idCounter = 0;
  const updateManyCalls: any[] = [];
  return {
    _seed(s: { confidence: string; outcomeConfirmed: boolean | null; calibratedProbability?: number | null }) {
      scenarios.push({ id: `s-${++idCounter}`, calibratedProbability: null, ...s });
    },
    _all: () => scenarios,
    _updateManyCalls: () => updateManyCalls,
    outcomeScenario: {
      groupBy: async ({ by, where }: any) => {
        let rows = scenarios;
        if (where?.outcomeConfirmed?.not === null) rows = rows.filter((s) => s.outcomeConfirmed !== null);
        const groups = new Map<string, any>();
        for (const r of rows) {
          const key = by.map((k: string) => String(r[k])).join('|');
          const existing = groups.get(key);
          if (existing) {
            existing._count._all++;
            continue;
          }
          const fresh: any = { _count: { _all: 1 } };
          for (const k of by) fresh[k] = r[k];
          groups.set(key, fresh);
        }
        return [...groups.values()];
      },
      updateMany: async ({ where, data }: any) => {
        updateManyCalls.push({ where, data });
        let count = 0;
        for (const s of scenarios) {
          if (where?.confidence && s.confidence !== where.confidence) continue;
          if (where?.calibratedProbability?.not === null && (s.calibratedProbability ?? null) === null) continue;
          Object.assign(s, data);
          count++;
        }
        return { count };
      },
    },
  };
}

const svc = (prisma: any) => new CalibrationService(prisma as any);

describe('Сверка [uncalibrated-number]: у числа должно быть право появиться', () => {
  describe('правило на своих данных', () => {
    /** РУЧНАЯ СВЕРКА МУТАЦИИ показала, что этот тест сначала держался
     * НЕ ТЕМ правилом: при выборке продукта в один исход числа нет
     * из-за условия ТЗ по всей выборке, и снятие порога КОРЗИНЫ тест
     * не ронял. Выборка датасета поднята до заведомо достаточной,
     * чтобы проверялось именно корзинное правило — тот самый случай,
     * который и был дефектом: один исход в корзине, 1.000 в поле. */
    it('КЛЮЧЕВОЙ ТЕСТ: один подтверждённый исход в корзине не даёт числа — null, а не 1.000', () => {
      const c = bucketCalibration({ total: 1, confirmed: 1 }, 100, 30);
      expect(c.calibratedProbability).toBeNull();
      expect(c.calibrated).toBe(false);
      expect(c.datasetReady).toBe(true); // выборка продукта тут не при чём
      expect(c.sampleSize).toBe(1);
    });

    it('на единицу ниже порога корзины числа ещё нет, на пороге — уже есть', () => {
      const below = bucketCalibration({ total: MIN_BUCKET_SAMPLE_SIZE - 1, confirmed: 10 }, 100, 30);
      const at = bucketCalibration({ total: MIN_BUCKET_SAMPLE_SIZE, confirmed: 10 }, 100, 30);
      expect(below.calibratedProbability).toBeNull();
      expect(at.calibratedProbability).toBeCloseTo(10 / MIN_BUCKET_SAMPLE_SIZE, 5);
    });

    it('пустая корзина: sampleSize 0 и число null, без делений на ноль и без NaN', () => {
      const c = bucketCalibration(undefined, 100, 30);
      expect(c.sampleSize).toBe(0);
      expect(c.calibratedProbability).toBeNull();
      expect(Number.isNaN(c.calibratedProbability as unknown as number)).toBe(false);
    });

    it('условие ТЗ по ВСЕЙ выборке проверяется отдельно: корзина дошла до своего порога, датасет — нет, числа нет', () => {
      // Достижимо только при пороге корзины НИЖЕ порога датасета:
      // выборка корзины никогда не больше всей выборки, поэтому при
      // равных порогах (сегодня оба 30) условие датасета выполняется
      // автоматически. Написано отдельно намеренно — это требование
      // ТЗ, и оно обязано выжить, если порог корзины когда-нибудь
      // смягчат.
      const c = bucketCalibration({ total: 5, confirmed: 5 }, 10, 30, 5);
      expect(c.calibratedProbability).toBeNull();
      expect(c.datasetReady).toBe(false);
      expect(c.sampleSize).toBe(5);
    });

    it('пустота объясняется разными словами: «мерить не на чем» отличается от «точность низкая»', () => {
      const dataset = bucketCalibration({ total: 5, confirmed: 5 }, 10, 30, 5);
      const partial = bucketCalibration({ total: 7, confirmed: 3 }, 100, 30);
      const empty = bucketCalibration(undefined, 100, 30);
      const done = bucketCalibration({ total: 30, confirmed: 15 }, 100, 30);
      expect(bucketCalibrationNote(dataset)).toContain('вся выборка продукта');
      expect(bucketCalibrationNote(partial)).toContain('7 из 30');
      expect(bucketCalibrationNote(partial)).not.toContain('нулевая');
      expect(bucketCalibrationNote(empty)).toContain('пока нет');
      expect(bucketCalibrationNote(done)).toContain('30 подтверждённым');
    });
  });

  describe('плановый пересчёт', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: три подтверждённых исхода в корзине не превращаются в calibratedProbability', async () => {
      const prisma = createFakePrisma();
      prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: true });
      prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: true });
      prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: false });
      await svc(prisma).recomputeCalibration();
      for (const s of prisma._all()) expect(s.calibratedProbability).toBeNull();
    });

    it('КЛЮЧЕВОЙ ТЕСТ: число, записанное прежней негодной калибровкой, снимается пересчётом, а не доживает до порога', async () => {
      const prisma = createFakePrisma();
      // Так выглядит корзина после прежней версии задания: одно
      // наблюдение и записанная в строки «точность» 1.000.
      prisma._seed({ confidence: 'LOW', outcomeConfirmed: true, calibratedProbability: 1 });
      prisma._seed({ confidence: 'LOW', outcomeConfirmed: null, calibratedProbability: 1 });
      await svc(prisma).recomputeCalibration();
      for (const s of prisma._all()) expect(s.calibratedProbability).toBeNull();
    });

    it('снятие числа адресуется только строкам, где число есть — плановое задание не переписывает всю таблицу каждую ночь', async () => {
      const prisma = createFakePrisma();
      prisma._seed({ confidence: 'HIGH', outcomeConfirmed: true });
      await svc(prisma).recomputeCalibration();
      const clearing = prisma._updateManyCalls().filter((c: any) => c.data.calibratedProbability === null);
      expect(clearing.length).toBeGreaterThan(0);
      for (const call of clearing) {
        expect(call.where.calibratedProbability).toEqual({ not: null });
      }
    });

    it('при достаточной выборке корзины число появляется и равно доле подтверждённых', async () => {
      const prisma = createFakePrisma();
      for (let i = 0; i < 40; i++) prisma._seed({ confidence: 'HIGH', outcomeConfirmed: i < 30 });
      await svc(prisma).recomputeCalibration();
      for (const s of prisma._all()) expect(s.calibratedProbability).toBeCloseTo(30 / 40, 5);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: набранная корзина не «вытягивает» соседнюю — у корзины с двумя исходами числа по-прежнему нет', async () => {
      const prisma = createFakePrisma();
      for (let i = 0; i < 30; i++) prisma._seed({ confidence: 'HIGH', outcomeConfirmed: true });
      prisma._seed({ confidence: 'LOW', outcomeConfirmed: true });
      prisma._seed({ confidence: 'LOW', outcomeConfirmed: false });
      await svc(prisma).recomputeCalibration();
      for (const s of prisma._all()) {
        if (s.confidence === 'HIGH') expect(s.calibratedProbability).toBeCloseTo(1, 5);
        else expect(s.calibratedProbability).toBeNull();
      }
    });
  });

  describe('статус для оператора', () => {
    it('в ответе перечислены ВСЕ корзины, включая пустые — отсутствующая обязана попасть строкой', async () => {
      const prisma = createFakePrisma();
      prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: true });
      const status = await svc(prisma).getStatus();
      expect(status.buckets.map((b) => b.confidence).sort()).toEqual(['HIGH', 'LOW', 'MEDIUM']);
      const low = status.buckets.find((b) => b.confidence === 'LOW');
      expect(low?.sampleSize).toBe(0);
      expect(low?.calibratedProbability).toBeNull();
    });

    /** Мутация «статус корзин считает датасет всегда набранным»
     * сначала УШЛА: при равных порогах признак datasetReady не влияет
     * на само число (выборка корзины никогда не больше всей), и
     * проверялось только число. А экран печатает по этому признаку
     * отдельную причину пустоты — «вся выборка меньше порога» вместо
     * «в этой корзине исходов нет». Причина обязана быть верной. */
    it('причина пустоты сообщается честно: при маленькой выборке продукта корзины помечены datasetReady: false', async () => {
      const prisma = createFakePrisma();
      prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: true });
      const small = await svc(prisma).getStatus();
      expect(small.sampleSize).toBe(1);
      for (const b of small.buckets) expect(b.datasetReady).toBe(false);

      for (let i = 0; i < 29; i++) prisma._seed({ confidence: 'MEDIUM', outcomeConfirmed: true });
      const big = await svc(prisma).getStatus();
      expect(big.sampleSize).toBe(30);
      for (const b of big.buckets) expect(b.datasetReady).toBe(true);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: тридцать исходов в одной корзине не выглядят как «измерены все три»', async () => {
      const prisma = createFakePrisma();
      for (let i = 0; i < 30; i++) prisma._seed({ confidence: 'HIGH', outcomeConfirmed: i < 20 });
      const status = await svc(prisma).getStatus();
      expect(status.gatePassed).toBe(true); // выборка продукта дошла до порога ТЗ
      const calibrated = status.buckets.filter((b) => b.calibrated).map((b) => b.confidence);
      expect(calibrated).toEqual(['HIGH']); // но измерена ровно одна
    });

    it('порог корзины сообщается в ответе, а не остаётся знанием экрана', async () => {
      const status = await svc(createFakePrisma()).getStatus();
      expect(status.bucketThreshold).toBe(MIN_BUCKET_SAMPLE_SIZE);
      for (const b of status.buckets) expect(b.threshold).toBe(MIN_BUCKET_SAMPLE_SIZE);
    });
  });

  describe('операторский экран больше не объясняет свой gate неверно', () => {
    const page = fs.readFileSync(
      path.join(SRC, '..', '..', 'admin', 'src', 'app', 'calibration', 'page.tsx'),
      'utf8',
    );

    it('КЛЮЧЕВОЙ ТЕСТ: снято утверждение «Gate проходит при score ниже порога» — gate проходит по размеру выборки', () => {
      const body = page.replace(/\/\/[^\n]*/g, '');
      expect(body).not.toContain('проходит при score ниже порога');
      expect(body).toContain('подтверждённых исходов набралось не меньше порога');
    });

    it('КЛЮЧЕВОЙ ТЕСТ: бейдж «не пройден» сравнивается с порогом, а не с нулём', () => {
      const body = page.replace(/\/\/[^\n]*/g, '');
      expect(body).toContain('data.sampleSize >= data.threshold');
      expect(body).not.toContain('data.sampleSize > 0');
    });

    it('прочерк в таблице корзин подписан «не откалибровано», а не оставлен пустым', () => {
      expect(page).toContain('не откалибровано');
      expect(page).toContain('а не «точность нулевая»');
    });
  });

  describe('инвариант держится там, где он записан', () => {
    it('schema.prisma по-прежнему объявляет NULL как «ещё не откалибровано» — код теперь этому соответствует', () => {
      const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
      expect(schema).toContain('NULL до накопления достаточной выборки');
    });

    it('запись числа идёт через bucketCalibration, а не считается на месте — правило одно и проверяемое', () => {
      const service = fs.readFileSync(path.join(SRC, 'calibration', 'calibration.service.ts'), 'utf8');
      expect(service).toContain('bucketCalibration(buckets.get(bucket)');
      // Прежняя арифметика на месте записи не должна вернуться.
      expect(service).not.toContain('counts.confirmed / counts.total');
    });
  });
});
