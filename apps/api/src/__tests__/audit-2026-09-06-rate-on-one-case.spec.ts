// Сверка 2026-09-06 — «100%» о человеке по одному случаю.
//
// НАЙДЕННОЕ. Экран «Калибровка решений» печатает фразу о самом
// человеке: «Прогноз совпал с реальным исходом в N из M случаев (X%)».
// Условие показа было одно — сравнимых случаев не ноль. То есть после
// ПЕРВОГО отмеченного исхода человек читал о себе «в 1 из 1 случаев
// (100%)», а при неудачном — «(0%)». Рядом, тем же экраном: «В 1
// случаях аргументы склоняли действовать, но исход оказался плохим —
// риск был недооценён» — утверждение о ПАТТЕРНЕ его решений,
// построенное на одном наблюдении.
//
// ПРАВИЛО В ПРОДУКТЕ БЫЛО. Разбивка по категориям того же экрана уже
// имела порог, и причина над ним записана прямым текстом: «один или два
// случая недостаточно, чтобы говорить о паттерне, не единичной
// случайности». К ОБЩЕЙ доле — главному числу, которое человек и
// читает, — правило применено не было. Третий раз подряд в этом ряду
// сверок: ПРАВИЛО БЫЛО, ПРОСТО НЕ ВЕЗДЕ.
//
// И ПОРОГ СЧИТАЛ НЕ ТЕ СЛУЧАИ. Категория проходила фильтр по числу ВСЕХ
// своих исходов, а доля считается по сравнимым — где есть и взвешенный
// прогноз, и определённый исход («смешанный» и «слишком рано судить» не
// в счёт). Пять отмеченных исходов, из которых сравним один, проходили
// порог и печатались как «1 из 1 (100%)». Порог стоял, но смотрел на
// другое число.
//
// ПОЧЕМУ ЭТО ХУЖЕ, ЧЕМ ТО ЖЕ САМОЕ НА ОПЕРАТОРСКОМ ЭКРАНЕ (Пункт
// [uncalibrated-number] тремя сверками раньше): там число внутреннее,
// здесь — фраза о человеке, которую он читает о себе. Продукт, который
// не выносит вердиктов о людях, сообщал ему «100%» о его собственном
// суждении по одному случаю.
//
// ГДЕ ПРОВЕРЯЕТСЯ ЧТО. Поведение сервиса — в
// decision-outcome.service.spec.ts, на реальных записях исходов. Здесь
// — правило на своих данных и то, чего в поведении не проверить:
// текст экрана.

import * as fs from 'fs';
import * as path from 'path';
import {
  MIN_RATE_SAMPLE_SIZE,
  notEnoughForRateNote,
  rateVisibility,
} from '../decision-outcome/rate-visibility';

const TMA_PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'tma', 'src', 'app', 'calibration', 'page.tsx'),
  'utf8',
);

describe('Сверка [rate-on-one-case]: доля о человеке требует случаев', () => {
  describe('правило на своих данных', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: один случай не даёт доли — null, а не 1', () => {
      const v = rateVisibility({ matchCount: 1, overOptimisticCount: 0, overCautiousCount: 0 });
      expect(v.classifiable).toBe(1);
      expect(v.rateShown).toBe(false);
      expect(v.matchRate).toBeNull();
    });

    it('КЛЮЧЕВОЙ ТЕСТ: неудачный первый случай тоже не даёт доли — иначе человек прочитал бы «0%»', () => {
      const v = rateVisibility({ matchCount: 0, overOptimisticCount: 1, overCautiousCount: 0 });
      expect(v.rateShown).toBe(false);
      expect(v.matchRate).toBeNull();
    });

    it('на единицу ниже порога доли нет, на пороге — есть', () => {
      const below = rateVisibility({ matchCount: 1, overOptimisticCount: 1, overCautiousCount: 0 });
      const at = rateVisibility({ matchCount: 1, overOptimisticCount: 1, overCautiousCount: 1 });
      expect(below.rateShown).toBe(false);
      expect(at.rateShown).toBe(true);
      expect(at.matchRate).toBeCloseTo(1 / 3, 5);
    });

    it('пустая выборка: ноль сравнимых, доля null, без NaN', () => {
      const v = rateVisibility({ matchCount: 0, overOptimisticCount: 0, overCautiousCount: 0 });
      expect(v.classifiable).toBe(0);
      expect(v.matchRate).toBeNull();
      expect(Number.isNaN(v.matchRate as unknown as number)).toBe(false);
    });

    it('«ещё не измерили» и «измерили, вышло ноль» — разные тексты', () => {
      const none = notEnoughForRateNote(rateVisibility({ matchCount: 0, overOptimisticCount: 0, overCautiousCount: 0 }));
      const few = notEnoughForRateNote(rateVisibility({ matchCount: 0, overOptimisticCount: 2, overCautiousCount: 0 }));
      expect(none).toContain('недостаточно данных');
      expect(few).toContain(`2 из ${MIN_RATE_SAMPLE_SIZE}`);
      expect(few).toContain('сказала бы о случайности');
      // Ни один из текстов не выносит суждения о человеке.
      for (const t of [none, few]) {
        expect(t).not.toMatch(/плохо|слабо|неточн/i);
      }
    });

    it('порог — одна константа на общую долю и на разбивку по категориям', () => {
      const service = fs.readFileSync(
        path.join(__dirname, '..', 'decision-outcome', 'decision-outcome.service.ts'),
        'utf8',
      );
      expect(service).toContain('const MIN_CATEGORY_SAMPLE_SIZE = MIN_RATE_SAMPLE_SIZE;');
    });
  });

  describe('что человек видит на экране', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: порог приходит с сервера, экран его не придумывает', () => {
      expect(TMA_PAGE).toContain('if (!stats.rateShown)');
      // Прежнее условие показа — «сравнимых не ноль» — не должно вернуться.
      expect(TMA_PAGE).not.toContain('if (classifiable === 0)');
    });

    it('КЛЮЧЕВОЙ ТЕСТ: утверждения о паттерне стоят внутри ветки, где доля показана', () => {
      // «Риск был недооценён» — это вывод о решениях человека. Он не
      // должен печататься там, где для доли случаев ещё мало.
      const shownBranch = TMA_PAGE.slice(TMA_PAGE.indexOf('Прогноз совпал с реальным исходом'));
      expect(shownBranch).toContain('риск был недооценён');
      const hiddenBranch = TMA_PAGE.slice(
        TMA_PAGE.indexOf('if (!stats.rateShown)'),
        TMA_PAGE.indexOf('Прогноз совпал с реальным исходом'),
      );
      expect(hiddenBranch).not.toContain('риск был недооценён');
      expect(hiddenBranch).not.toContain('риск был переоценён');
    });
  });
});
