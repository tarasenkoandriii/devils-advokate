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
// вообще — сверять стало нечего. Остались инварианты сида, каждый из
// которых закрывает конкретный найденный дефект.
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

  // Сид деактивирует capability, которых сам не завёл — иначе снятый с
  // производства слаг (grok-4 после grok-4.3) выигрывает подбор вечно.
  // Гасятся только строки провайдеров, которых ведёт сам сид: чужие
  // (заведённые оператором вручную) не трогаются.
  it('деактивация ограничена провайдерами, которых ведёт сид', () => {
    const s = seed();
    const guard = s.match(/const seededProviderIds = \[([\s\S]*?)\];/);
    expect(guard).not.toBeNull();
    const listed = [...guard![1].matchAll(/(\w+)\.id/g)].map((m) => m[1]);
    const created = [...s.matchAll(/const (\w+) = await upsertProvider\(/g)].map((m) => m[1]);
    expect(created.length).toBeGreaterThan(3);
    expect(created.filter((v) => !listed.includes(v))).toEqual([]);
  });

  // Регрессия 2026-09-02: прежнее условие сравнивало ВЕРСИИ моделей
  // (`modelVersionId notIn seededVersionIds`), а версия assemblyai сидом
  // заводится — её оставшаяся с прежних времён capability под условие не
  // попадала, оставалась active и утаскивала текстовую задачу в
  // провайдера без клиента. Сравнение должно идти по строкам, которые
  // сид реально завёл в этом прогоне.
  it('КЛЮЧЕВОЙ ТЕСТ: лишние capability гасятся по списку заведённых строк, а не по списку версий', () => {
    const s = seed();
    expect(s).toContain('upsertedCapabilityIds');
    // Условие деактивации опирается на id заведённых строк…
    expect(s).toMatch(/id:\s*\{\s*notIn:\s*upsertedCapabilityIds\s*\}/);
    // …а не на версии моделей: этот вариант и пропустил assemblyai.
    expect(s).not.toMatch(/modelVersionId:\s*\{\s*notIn:\s*seededVersionIds\s*\}/);
  });

  // Прямая страховка от возврата удалённого измерения: если кто-то
  // снова начнёт заводить capability под конкретную задачу, вернётся и
  // весь класс «фича мертва при живых ключах».
  it('в сиде не осталось привязки capability к taskType', () => {
    const s = seed();
    expect(s).not.toMatch(/aIModelCapability[\s\S]{0,200}taskType/);
  });
});
