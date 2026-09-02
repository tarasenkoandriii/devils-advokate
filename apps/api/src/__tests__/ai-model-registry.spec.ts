// Инварианты реестра моделей в сиде.
//
// История файла. Он назывался ai-capabilities-coverage.spec.ts и держал
// сходящимися два списка: taskType в коде и taskType в сиде. Тот тест
// был правильным ответом на неправильную конструкцию: capability
// заводилась на КАЖДУЮ пару (модель × задача), 192 строки, и забытая
// строка молча убивала фичу при живых ключах (семь доменов разом,
// AUDIT-AI-CAPABILITIES-2026-09-01.md).
//
// Пункт [router-simplify] убрал само измерение: строка одна на модель,
// подбор идёт по наличию ключа, новая фича не требует правок в сиде
// вообще — сверять стало нечего. Осталось три инварианта, каждый из
// которых закрывает найденный в этот же день дефект.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEED = join(__dirname, '..', '..', 'prisma', 'seed.ts');
const seed = () => readFileSync(SEED, 'utf8');

describe('сид: реестр провайдеров и моделей', () => {
  // Правка apiEndpoint/credentialRef с `update: {}` не долетала до уже
  // засеянной базы: коммит выглядит применённым, прод ходит по старому
  // адресу и ищет ключ в переменной со старым именем.
  it('КЛЮЧЕВОЙ ТЕСТ: провайдеры заводятся только через upsertProvider, без update:{}', () => {
    const s = seed();
    const direct = [...s.matchAll(/prisma\.aIProvider\.upsert\(/g)].length;
    // Единственный допустимый прямой upsert — внутри самого хелпера.
    expect(direct).toBe(1);
    expect(s).toContain('async function upsertProvider(');
    expect([...s.matchAll(/await upsertProvider\(/g)].length).toBeGreaterThanOrEqual(5);
  });

  // То же для capability: строка на модель приводится к сиду, иначе
  // модель, выключенную прошлым прогоном, не вернуть повторным сидом.
  it('capability заводится только через upsertCapability', () => {
    const s = seed();
    expect([...s.matchAll(/prisma\.aIModelCapability\.upsert\(/g)].length).toBe(1);
    expect(s).toContain('async function upsertCapability(');
    expect([...s.matchAll(/await upsertCapability\(/g)].length).toBeGreaterThanOrEqual(2);
  });

  // Сид деактивирует capability моделей, которых в нём больше нет —
  // иначе снятый с производства слаг (grok-4 после grok-4.3) выигрывает
  // подбор вечно. Обратная сторона: забыли версию в seededVersionIds —
  // и сид погасит собственные модели на следующем прогоне.
  it('КЛЮЧЕВОЙ ТЕСТ: все версии моделей, которые сид создаёт, перечислены в seededVersionIds', () => {
    const s = seed();
    const created = [...s.matchAll(/const (\w+) = await prisma\.aIModelVersion\.upsert\(/g)].map((m) => m[1]);
    const guard = s.match(/const seededVersionIds = \[([\s\S]*?)\];/);
    expect(guard).not.toBeNull();
    const listed = [...guard![1].matchAll(/(\w+)\.id/g)].map((m) => m[1]);
    expect(created.length).toBeGreaterThan(3);
    expect(created.filter((v) => !listed.includes(v))).toEqual([]);
  });

  // Прямая страховка от возврата удалённого измерения: если кто-то
  // снова начнёт заводить capability под конкретную задачу, вернётся и
  // весь класс «фича мертва при живых ключах».
  it('в сиде не осталось привязки capability к taskType', () => {
    const s = seed();
    expect(s).not.toMatch(/aIModelCapability[\s\S]{0,200}taskType/);
  });
});
