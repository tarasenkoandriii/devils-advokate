// Повторный аудит 2026-09-01 — «у сценария классификатора есть экран» как тест.
//
// Найдено сверкой API с TMA: `job-search` был в INTAKE_SCENARIOS и в
// промпте классификатора, `onboardingFor()` его обслуживал, а манифеста
// в TMA не существовало. Пользователь получал «Похоже на: job-search»,
// подтверждал, бэкенд УСПЕШНО создавал конфиг, проект и онбординг-
// разговор со всеми ответами — и редирект приводил на «Неизвестный
// сценарий.» без пути назад. Данные созданы, добраться до них нельзя.
//
// Класс тот же, что у разрыва «код ↔ строки конфигурации в БД»: два
// списка в разных местах, которые обязаны сходиться, и ничто их не
// сверяет. Тест держит их вместе — и падает на CI, а не на пользователе.
//
// Читает TMA как ТЕКСТ намеренно: apps/api не должен импортировать код
// TMA (разные tsconfig и сборки), а разъезжаются именно списки.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTAKE_SCENARIOS } from '../intake/intake.service';

const TMA_TYPES = join(__dirname, '..', '..', '..', 'tma', 'src', 'lib', 'domains', 'types.ts');
const TMA_MANIFESTS = join(__dirname, '..', '..', '..', 'tma', 'src', 'lib', 'domains', 'manifests.ts');

function tmaDomainIds(): string[] {
  const text = readFileSync(TMA_TYPES, 'utf8');
  const m = text.match(/export type DomainId =([^;]+);/);
  if (!m) throw new Error('в apps/tma/src/lib/domains/types.ts не найден тип DomainId');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function tmaRegisteredManifests(): string[] {
  const text = readFileSync(TMA_MANIFESTS, 'utf8');
  const m = text.match(/export const DOMAIN_MANIFESTS[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) throw new Error('в manifests.ts не найден DOMAIN_MANIFESTS');
  // Ключи объекта: и `dtp,` (шорткат), и `'family-law': familyLaw`.
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  const quoted = [...body.matchAll(/'([^']+)'\s*:/g)].map((x) => x[1]);
  const shorthand = [...body.matchAll(/(?:^|,)\s*([a-zA-Z][\w]*)\s*(?=,|$)/gm)].map((x) => x[1]);
  return [...new Set([...quoted, ...shorthand])];
}

describe('intake: у каждого сценария классификатора есть экран в TMA', () => {
  const domainIds = tmaDomainIds();
  const registered = tmaRegisteredManifests();
  // UNIVERSAL — не домен: он уводит в обычный проект, не в /domains.
  const domainScenarios = INTAKE_SCENARIOS.filter((s) => s !== 'UNIVERSAL');

  it('файлы TMA разобраны (страховка от смены формата)', () => {
    expect(domainIds.length).toBeGreaterThan(3);
    expect(registered.length).toBeGreaterThan(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждый сценарий интейка есть в DomainId приложения', () => {
    const missing = domainScenarios.filter((s) => !domainIds.includes(s));
    // Пустой массив, а не length: сообщение назовёт конкретный сценарий.
    expect(missing).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: для каждого сценария зарегистрирован манифест (тип без манифеста — тот же тупик)', () => {
    const missing = domainScenarios.filter((s) => !registered.includes(s));
    expect(missing).toEqual([]);
  });

  it('в TMA нет домена, которого не знает классификатор (иначе плитка ведёт в никуда)', () => {
    const orphans = domainIds.filter((d) => !domainScenarios.includes(d as (typeof domainScenarios)[number]));
    expect(orphans).toEqual([]);
  });
});
