// Сверка 2026-09-30 — согласие, у которого не было ни одной проверки.
//
// НАЙДЕНО. `ConsentType.RELIGIOUS_CONTENT` упоминался во всём
// `apps/api/src` дважды, и оба раза — выдача и отзыв, не проверка. Весь
// религиозный контент гейтился полем `User.religion`, а отзыв согласия
// его не касался: человек жал «отозвать», отчёт говорил «готово», и
// напоминания о заповедях, цитаты, анекдоты и религиозная часть
// завершающего сообщения продолжали приходить.
//
// Из тринадцати типов согласия ЭТОТ ЕДИНСТВЕННЫЙ не имел ни одной
// точки проверки. Остальные двенадцать имеют хотя бы одну — то есть
// правило в проекте было, просто не везде, в десятый раз.
//
// ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ. Замкнутость: у КАЖДОГО типа согласия есть
// место, где он проверяется, — правило по дереву, а не список
// известных мест. Ценность в ЧЕТЫРНАДЦАТОМ типе, которого ещё нет:
// именно так появился тринадцатый без проверки.
//
// Поведение самого гейта проверяется там, где он применён
// (`reconciliation-arguments.service.spec.ts` — отозванное согласие
// даёт 403), и это поведенческая проверка, а не текстовая.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConsentType } from '@prisma/client';
import { RELIGION_NOT_SET } from '../consent/religious-content';
import { REVOCATION_EFFECTS } from '../consent/consent-revocation-effects';

const API_SRC = join(__dirname, '..');

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(full.slice(API_SRC.length + 1));
    }
  })(API_SRC);
  return out;
}

/** Места, где согласие ВЫДАЁТСЯ или ОТЗЫВАЕТСЯ, а не проверяется.
 * Упоминание типа там не делает его проверяемым — ровно на этой
 * разнице сверка и споткнулась бы, считая упоминания. */
const NOT_A_CHECK = ['consent/consent.service.ts', 'consent/consent-revocation-effects.ts', 'onboarding/onboarding.service.ts'];

/** Типы, чья проверка написана НЕ через `ConsentService`, — с
 * причиной у каждого. Список короткий намеренно: каждая строчка здесь
 * — место, куда общее правило не заглядывает. */
const CHECKED_ELSEWHERE: Array<{ type: ConsentType; where: string; why: string }> = [
  {
    type: ConsentType.CANDIDATE_DATA_TRANSFER,
    where: 'candidate-self-share/candidate-self-share.service.ts',
    why:
      'проверка написана сырым запросом к ConsentRecord мимо ConsentService НАРОЧНО: она сверяет не только тип, но и ВЕРСИЮ текста согласия (CONSENT_TEXT_VERSION) и конкретное ребро передачи (purposes has edge) — ни того, ни другого ConsentService не умеет',
  },
];

/** Где ищем проверки: любое место, которое спрашивает право, — прямой
 * `requireConsent` / `hasActiveConsent` с этим типом, либо общий
 * помощник, внутри которого тип назван. */
function typesChecked(): Set<string> {
  const checked = new Set<string>();
  for (const e of CHECKED_ELSEWHERE) {
    // Проверка обязана СУЩЕСТВОВАТЬ там, где заявлена: реестр,
    // переживший свой код, — это «проверка, которая выглядит
    // существующей».
    const src = code(e.where);
    if (src.includes('consentType') && src.includes(e.type)) checked.add(e.type);
  }
  for (const file of sourceFiles()) {
    const src = code(file);
    if (!/requireConsent\(|hasActiveConsent\(/.test(src)) continue;
    const isRegistry = NOT_A_CHECK.some((n) => file === n);
    for (const t of Object.values(ConsentType)) {
      if (!src.includes(`ConsentType.${t}`)) continue;
      if (isRegistry) continue;
      checked.add(t);
    }
  }
  return checked;
}

describe('[the-consent-that-stopped-nothing] у каждого согласия есть проверка', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни один тип согласия не остался без места проверки', () => {
    const checked = typesChecked();
    const unchecked = Object.values(ConsentType).filter((t) => !checked.has(t));
    expect(unchecked).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: разбор действительно находит проверки, а не пустоту', () => {
    // Пустой список выше означал бы не порядок, а сломанный разбор —
    // ошибка, на которой этот ряд сверок себя уже ловил.
    const checked = typesChecked();
    expect(checked.size).toBe(Object.values(ConsentType).length);
    // И реестр выдачи/отзыва в число проверяющих НЕ попадает: иначе
    // правило зеленело бы от одного упоминания типа в реестре.
    expect(NOT_A_CHECK.every((f) => sourceFiles().includes(f))).toBe(true);
    // У каждого исключения — существующее место и написанная причина.
    for (const e of CHECKED_ELSEWHERE) {
      expect(sourceFiles().includes(e.where)).toBe(true);
      expect(e.why.length > 60).toBe(true);
    }
    expect(CHECKED_ELSEWHERE.length <= 2).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: религиозный контент гейтится согласием во ВСЕХ четырёх местах, где он производится', () => {
    // Числа, а не наличие слова: мест четыре, и «в файле есть
    // согласие» прошло бы, даже если проверку поставили в одном из
    // них. Все четыре обязаны спрашивать право через общего
    // помощника — три копии чтения `religion` и были причиной, по
    // которой четвёртое место осталось без проверки.
    const sites = [
      'religious-reminder/religious-reminder.service.ts',
      'situational-content/situational-content.service.ts',
      'reconciliation-arguments/reconciliation-arguments.service.ts',
      'closing-message/closing-message.service.ts',
    ];
    const offenders: string[] = [];
    for (const site of sites) {
      const src = code(site);
      const asksRight =
        src.includes('religiousContentAllowed(') ||
        src.includes('assertReligiousContentAllowed(') ||
        /hasActiveConsent\([^)]*ConsentType\.RELIGIOUS_CONTENT/.test(src);
      if (!asksRight) offenders.push(`${site}: право на религиозный контент не спрашивается`);
    }
    expect(offenders).toEqual([]);

    // И ни одно из четырёх мест больше не решает по одному полю
    // `religion`: такое чтение и было гейтом, который отзыв не трогал.
    const byFieldOnly: string[] = [];
    for (const site of sites) {
      const src = code(site);
      if (!/select: \{ religion: true \}/.test(src)) continue;
      if (src.includes('religiousContentAllowed(') || src.includes('assertReligiousContentAllowed(')) continue;
      byFieldOnly.push(site);
    }
    expect(byFieldOnly).toEqual([]);
  });

  it('текст об отзыве больше не выдаёт настройку за то, что она не значит', () => {
    const effect = REVOCATION_EFFECTS[ConsentType.RELIGIOUS_CONTENT];
    // Прежний текст — «Настройки, которые вы указали при онбординге,
    // остаются — их можно изменить там же» — был буквально верен и
    // вводил в заблуждение: ИМЕННО ЭТИ НАСТРОЙКИ И БЫЛИ ВСЕМ ГЕЙТОМ.
    expect(effect.doesNotUndo.includes('Настройки, которые вы указали при онбординге, остаются')).toBe(false);
    expect(effect.doesNotUndo.includes('Вероисповедание')).toBe(true);
    // `alsoDoes` остаётся null, и это точно: сверх пометки записи отзыв
    // здесь ничего не делает — он просто начинает работать.
    expect(effect.alsoDoes).toBe(null);
    // Отказ человеку — один текст на все места, а не четыре разных.
    expect(RELIGION_NOT_SET.length).toBeGreaterThan(40);
  });
});
