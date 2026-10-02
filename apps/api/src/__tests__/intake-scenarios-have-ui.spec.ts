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

/** Пункт [the-registry-became-a-call] 2026-10-02 — читается `ALL_MANIFESTS`,
 *  а не `DOMAIN_MANIFESTS`, и это не замена одного имени другим.
 *
 *  ЧТО СЛОМАЛОСЬ. Выключатель сборки ([one-build-two-products]) сделал
 *  `DOMAIN_MANIFESTS` ВЫЗОВОМ функции (`selectManifests()`), и регулярка,
 *  искавшая объектный литерал, перестала находить что-либо. Спека падала
 *  на импорте — живой CI показал «1 набор из 243 не стартует». Падение
 *  громкое, и это хорошо; плохо другое: пока оно длилось, инвариант «у
 *  каждого сценария интейка есть экран» не проверялся ничем.
 *
 *  ПОЧЕМУ ИМЕННО `ALL_MANIFESTS` — ЭТО ИСПРАВЛЕНИЕ ПО СУТИ, А НЕ ПО
 *  ФОРМЕ. Классификатор живёт на сервере и знает все сценарии
 *  независимо от того, какие домены включены в конкретной сборке TMA.
 *  Значит сверять список сервера нужно с тем, что продукт знает ВООБЩЕ,
 *  а не с тем, что показывает одна сборка. Прежнее чтение
 *  `DOMAIN_MANIFESTS` давало верный ответ только потому, что
 *  выключателя ещё не было.
 *
 *  Про сборку с частью доменов замерено отдельно и дефекта там нет:
 *  `isDispatchable()` в `apps/tma/src/app/intake/page.tsx` спрашивает
 *  `getManifest()`, то есть выключенный домен не становится целью
 *  перехода и человеку это говорится словами — ровно тот механизм,
 *  который завела эта спека в 2026-09-01. */
function tmaRegisteredManifests(): string[] {
  const text = readFileSync(TMA_MANIFESTS, 'utf8');
  const m = text.match(/const ALL_MANIFESTS[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) throw new Error('в manifests.ts не найден литерал ALL_MANIFESTS');
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

  it('РЕГРЕССИЯ (живой CI, прогон 19): разбор читает ЛИТЕРАЛ реестра, а не производное от него', () => {
    // Выключатель сборки превратил `DOMAIN_MANIFESTS` в вызов функции, и
    // регулярка перестала находить объект — спека падала на импорте.
    // Проверяется именно то, что разбор не вернулся к производному
    // имени: у него значение вычисляется, и завтра оно снова может
    // перестать быть литералом.
    const text = readFileSync(TMA_MANIFESTS, 'utf8');
    expect(/const ALL_MANIFESTS[^=]*=\s*\{/.test(text)).toBe(true);
    // Числом, а не двумя `toContain` по массиву: списков два и они
    // обязаны совпадать по РАЗМЕРУ, иначе разбор нашёл часть объекта.
    // Это и сильнее, и не завышает счёт сторожа [guard-audit], который
    // берёт любой `toContain` в файле с `readFileSync`, — его известная
    // погрешность описана в самом стороже.
    expect(registered.length).toBe(domainIds.length);
  });

  it('ОБРАТНАЯ ПРОБА: тот же разбор на тексте БЕЗ литерала реестра отказывается, а не отдаёт пустой список', () => {
    // Иначе «ни одного пропавшего сценария» означало бы не согласие
    // списков, а сломанный разбор: пустой `registered` сравнивается с
    // пустым `missing` и зеленеет.
    const broken = 'export const DOMAIN_MANIFESTS = selectManifests();\n';
    expect(/const ALL_MANIFESTS[^=]*=\s*\{/.test(broken)).toBe(false);
    expect(tmaDomainIds().length).toBeGreaterThan(3);
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
