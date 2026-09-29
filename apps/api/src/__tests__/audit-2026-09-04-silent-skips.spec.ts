// Сверка молчаливых пропусков 2026-09-04 — пятый заход про одну форму.
//
// Четыре предыдущих захода нашли один и тот же дефект в разных местах:
// обрезанный список без подписи, молчаливое удаление проекта, неполная
// выгрузка, исчезнувший из сравнения кандидат. Общее — «пробел выглядит
// как полнота». Этот заход искал остальные случаи системно: все `continue`
// в сервисах, то есть все места, где что-то выбрасывается из результата.
//
// РЕЗУЛЬТАТ ЧЕСТНЕЕ ОЖИДАНИЙ: 91 `continue`, и почти все — обычная
// фильтрация внутри вычисления (не тот пункт, не то состояние, дубль),
// которую человек не видит и видеть не должен. Пятого крупного случая не
// нашлось, и выдумывать его не нужно: «искали и не нашли» — это результат.
//
// Нашлись две несогласованности, обе мелкие и обе настоящие:
//
// 1. Три детектора (поворотные точки, манипулятивные приёмы, «это лучше не
//    говорить») молча выбрасывали находку, когда модель сослалась на
//    несуществующую реплику. `ParalinguisticsService` в такой же ситуации
//    СЧИТАЕТ пропуски и пишет предупреждение — приём в проекте был, просто
//    не везде. Пропущенная находка означает, что находок меньше, чем
//    нашла модель, и отличить это от «находок нет» было нельзя даже по
//    логам.
//
// 2. `EmployerDossierService.refresh()` отбрасывал источник на домене
//    самой компании (правило §3.7/§3.8 — «о компании судим не по её
//    собственному сайту») и не считал это. При этом соседние отбрасывания
//    в том же отчёте названы: `failed` и `skippedByRules`. Отчёт, который
//    называет два отбрасывания из трёх, хуже отчёта, который не называет
//    ни одного: он выглядит полным.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Детекторы, которые сопоставляют ответ модели с реальными репликами.
 * У всех четырёх пропуск обязан считаться — иначе потеря находки
 * невидима даже в логе. */
const DETECTORS = [
  'conversations/paralinguistics.service.ts',
  'turning-points/turning-points.service.ts',
  'manipulation-detector/manipulation-detector.service.ts',
  'do-not-say/do-not-say.service.ts',
];

describe('Молчаливые пропуски: то, что выброшено, должно быть посчитано', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: все детекторы считают находки, потерянные из-за выдуманной моделью реплики', () => {
    const silent: string[] = [];
    for (const rel of DETECTORS) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      if (!/invented\+\+/.test(src)) silent.push(rel);
    }
    expect(silent).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: посчитанное ещё и произносится — счётчик без предупреждения бесполезен', () => {
    // Счётчик, который никто не читает, — это та же тишина, только с
    // переменной. Проверяется, что рядом есть предупреждение в лог.
    const mute: string[] = [];
    for (const rel of DETECTORS) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      if (!/invented > 0/.test(src) || !/logger\.warn/.test(src)) mute.push(rel);
    }
    expect(mute).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отчёт обновления досье называет ВСЕ три вида отбрасывания, а не два из трёх', () => {
    const src = readFileSync(join(SRC, 'employer-dossier/employer-dossier.service.ts'), 'utf8');
    for (const field of ['failed', 'skippedByRules', 'skippedOwnDomain']) {
      expect(src).toContain(`${field}`);
    }
    // И само отбрасывание по домену компании действительно увеличивает счётчик.
    expect(src).toMatch(/normalizeHost\(src\.url\) === dossier\.domain\) \{[\s\S]{0,120}skippedOwnDomain\+\+/);
  });

  it('ИЗМЕРЕНИЕ: `continue` в сервисах много, и это нормально — важно, какие из них человек мог бы увидеть', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта, а не с
    // ощущения. Резкий рост — повод посмотреть, не появился ли новый
    // молчаливый пропуск в том, что человек читает как полный список.
    let total = 0;
    for (const file of tsFiles(SRC)) {
      total += (readFileSync(file, 'utf8').match(/\bcontinue;/g) ?? []).length;
    }
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThan(200);
  });
});
