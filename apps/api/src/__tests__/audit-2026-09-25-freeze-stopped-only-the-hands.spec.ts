// Пункт [freeze-stopped-only-the-hands] 2026-09-25 — заморозка
// останавливала только руки человека, но не машину.
//
// Здесь — то, что не выразить поведением одного сервиса: что граница
// проведена по ВСЕМ фоновым задачам, а не по тем, о которых вспомнили.
// Поведение каждой стороны проверено там, где происходит:
// `ai-router-async.spec.ts` (провайдеру не ушло ничего, падение
// окончательное, причина словами) и `vacancy-intake.service.spec.ts`
// (замороженный проект не перечитывается, живой — перечитывается).

import { BACKGROUND_UNDER_FREEZE, FROZEN_JOB_REASON } from '../project-freeze/frozen-background';
import { EXPECTED_CRON_JOBS } from '../admin-db-state/expected-cron-jobs';

describe('[freeze-stopped-only-the-hands] решение о фоновой работе принято по каждой задаче', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: реестр решений и список cron-задач совпадают в обе стороны', () => {
    // В одну сторону — новая фоновая задача без решения о заморозке; в
    // другую — решение, пережившее свою задачу. Обе одинаково
    // превращают границу в декларацию. Тот же приём, что у реестра
    // ручных миграций: список, написанный по памяти, отстаёт.
    expect(BACKGROUND_UNDER_FREEZE.map((b) => b.job).sort()).toEqual(EXPECTED_CRON_JOBS.map((j) => j.jobname).sort());
  });

  it('КЛЮЧЕВОЙ ТЕСТ: граница не вырождена — есть и останавливаемые, и продолжающиеся', () => {
    // Реестр, где всё «останавливается», означал бы заморозку-паралич;
    // реестр, где всё «продолжается», — заморозку-бумажку. Обе крайности
    // проходили бы проверку выше.
    const stops = BACKGROUND_UNDER_FREEZE.filter((b) => b.stops);
    const continues = BACKGROUND_UNDER_FREEZE.filter((b) => !b.stops);
    expect(stops.length).toBeGreaterThan(0);
    expect(continues.length).toBeGreaterThan(0);
    // Деньги и новые данные — останавливаются поимённо.
    expect(stops.map((b) => b.job).sort()).toEqual(['ai-jobs-submit', 'job-search-refetch-watched']);
  });

  it('у каждого решения записана причина, а не одно слово', () => {
    for (const b of BACKGROUND_UNDER_FREEZE) {
      expect(b.why.length).toBeGreaterThan(50);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человек узнаёт ПРИЧИНУ, а не «не получилось»', () => {
    // Пустое «ошибка» на месте результата — ровно та пустота, которую
    // продукт себе запрещает: её человек прочитает как «разбор ничего
    // не нашёл».
    expect(FROZEN_JOB_REASON).toContain('проект заморожен оператором');
    expect(FROZEN_JOB_REASON).toContain('к провайдеру ничего не отправлялось');
    expect(FROZEN_JOB_REASON.length).toBeGreaterThan(60);
  });
});
