// Сверка 2026-09-06 — реестр выгрузки закрывал связи проекта и на том
// останавливался.
//
// НАЙДЕННОЕ. Сверка 2026-09-04 сделала для модели Project ровно то, что
// нужно: реестр «каждая связь либо в выгрузке, либо в исключениях с
// причиной» плюс тест, который не даёт реестру отстать от схемы. Но
// применено это было к одной модели. У модели User связей шестнадцать,
// и про них не говорил никто — ни выгрузка, ни исключения, ни тест.
//
// Измерено: из шестнадцати в выгрузке были семь. Девять молчали, и
// среди них:
//
//  • `voiceEmbedding` — ГОЛОСОВОЙ ОТПЕЧАТОК: биометрический
//    идентификатор, который продукт хранит под отдельным согласием
//    VOICE_BIOMETRIC. В выгрузке о нём не было ни строки — ни данных,
//    ни упоминания, что они есть. Человек, попросивший «всё, что вы
//    обо мне храните», не узнавал о самом чувствительном из хранимого.
//    И спрятался он ровно там, куда проверка не смотрела: это
//    ОДИНОЧНАЯ связь (`VoiceEmbedding?`), а тест для проекта обходил
//    только списки (`Model[]`);
//  • записи в общую библиотеку, заявки на площадки, подтверждения
//    бронирований — тексты, написанные самим человеком;
//  • созданные им ссылки-самошеринги — журнал того, кому он отдавал
//    свои данные.
//
// Плюс выгрузка не отдавала СОБСТВЕННЫЕ ПОЛЯ АНКЕТЫ: город, страну,
// язык, религию, режим приватности, настройки напоминаний.
//
// ФОРМА: ПРАВИЛО БЫЛО, ПРОСТО НЕ ВЕЗДЕ — третий раз подряд в этом ряду
// сверок. И заодно: проверка смотрела туда, где искали (списки), а не
// туда, где может случиться (любая связь).
//
// ЧТО ПРОВЕРЕНО И ОКАЗАЛОСЬ ВЕРНЫМ: комментарий в сервисе утверждает,
// что «все 16 связей на User каскадные». Сверено со схемой —
// шестнадцать из шестнадцати. Утверждение верное; проверка на него
// добавлена, чтобы оно не разошлось с кодом позже.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXPORTED_USER_RELATIONS,
  USER_EXPORT_EXCLUSIONS,
  EXPORTED_USER_PROFILE_FIELDS,
  USER_PROFILE_EXCLUSIONS,
} from '../privacy-center/export-scope';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const SERVICE = readFileSync(join(__dirname, '..', 'privacy-center', 'privacy-center.service.ts'), 'utf8');
const EXPORT_BODY = SERVICE.slice(SERVICE.indexOf('async exportData'));

/** Связи модели User прямо из схемы — И СПИСОЧНЫЕ, И ОДИНОЧНЫЕ.
 * Одиночные здесь не педантизм: голосовой отпечаток был именно
 * одиночной связью и именно поэтому не попал ни в какую проверку. */
function userRelations(): Array<{ field: string; model: string; list: boolean }> {
  const body = /^model User \{([\s\S]*?)^\}/m.exec(SCHEMA)?.[1] ?? '';
  const out: Array<{ field: string; model: string; list: boolean }> = [];
  for (const line of body.split('\n')) {
    const m = /^\s+(\w+)\s+([A-Z]\w*)(\[\]|\?)?\s*(\/\/.*)?$/.exec(line.replace(/\s+@.*$/, ''));
    if (!m) continue;
    const [, field, model, suffix] = m;
    // Перечисления и скалярные типы — не связи.
    if (!new RegExp(`^model ${model} \\{`, 'm').test(SCHEMA)) continue;
    out.push({ field, model, list: suffix === '[]' });
  }
  return out;
}

function userFkModels(): Array<{ model: string; onDelete: string }> {
  const out: Array<{ model: string; onDelete: string }> = [];
  let cur: string | null = null;
  for (const line of SCHEMA.split('\n')) {
    const m = /^model (\w+) \{/.exec(line);
    if (m) { cur = m[1]; continue; }
    if (line.startsWith('}')) { cur = null; continue; }
    if (!cur || !line.includes('references: [id]') || !/\bUser\b/.test(line)) continue;
    const od = /onDelete:\s*(\w+)/.exec(line);
    out.push({ model: cur, onDelete: od ? od[1] : 'Restrict (по умолчанию)' });
  }
  return out;
}

describe('Сверка [export-user-scope]: реестр выгрузки обязан покрывать и сам аккаунт', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: про каждую связь User сказано — либо она в выгрузке, либо в исключениях с причиной', () => {
    const unaccounted = userRelations()
      .map((r) => r.field)
      .filter((f) => !EXPORTED_USER_RELATIONS.includes(f) && !(f in USER_EXPORT_EXCLUSIONS));
    expect(unaccounted).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: обход берёт и ОДИНОЧНЫЕ связи — иначе голосовой отпечаток снова прошёл бы мимо', () => {
    const singles = userRelations().filter((r) => !r.list);
    expect(singles.map((r) => r.field)).toContain('voiceEmbedding');
    // И отпечаток обязан быть по ту сторону, где он выгружается, а не
    // по ту, где он «исключён по причине».
    expect(EXPORTED_USER_RELATIONS).toContain('voiceEmbedding');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: объявленное выгружаемым действительно запрашивается у базы', () => {
    // Реестр без запроса — декларация. Связь проверяется по МОДЕЛИ, в
    // которую она ведёт: у User имя связи и имя таблицы расходятся
    // (`createdPeople` → `person`).
    const byField = new Map(userRelations().map((r) => [r.field, r.model]));
    const notQueried = EXPORTED_USER_RELATIONS.filter((field) => {
      const model = byField.get(field)!;
      const call = model[0].toLowerCase() + model.slice(1);
      return !new RegExp(`prisma\\.${call}\\.find`).test(EXPORT_BODY);
    });
    expect(notQueried).toEqual([]);
  });

  /** ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Первая версия этой сверки проверяла
   * текстом исходника, что вектор отпечатка не выбирается, что ключи
   * самошеринга не попадают в `select` и что в `notIncluded` есть
   * слово «биометрический». Всё это ПРОВЕРЯЕТСЯ ПОВЕДЕНИЕМ — в
   * privacy-center.service.spec.ts, на реальном ответе `exportData()`:
   * вектора в JSON нет, строки «СЕКРЕТ» (так назван токен в фейке) в
   * нём нет, заметки модератора нет, а причина в `notIncluded` есть.
   * Метапроверка проверок (audit-2026-09-04-guard-audit) сработала
   * ровно на этом: текстовых утверждений стало больше потолка, и
   * первое, что следовало сделать, — убрать те, у которых уже есть
   * поведенческий двойник, а не поднять потолок. */

  /** Мутация «поле анкеты выпало из выгрузки» сначала УШЛА: список
   * полей проверялся поимённо, но со схемой не сверялся — то есть мог
   * молча усохнуть. Ровно тот изъян, который эта сверка и нашла в
   * реестре связей, повторённый мной в реестре полей. Закрыто обходом:
   * каждое скалярное поле аккаунта обязано быть либо в выгрузке, либо
   * в исключениях с причиной. */
  it('КЛЮЧЕВОЙ ТЕСТ: про каждое поле аккаунта сказано — либо оно в выгрузке, либо в исключениях с причиной', () => {
    const body = /^model User \{([\s\S]*?)^\}/m.exec(SCHEMA)?.[1] ?? '';
    const scalars: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trimEnd();
      const m = /^\s+(\w+)\s+([A-Za-z]\w*)(\[\])?(\?)?/.exec(line);
      if (!m) continue;
      const [, field, type, isList] = m;
      if (isList) continue; // связи-списки проверяются выше
      if (new RegExp(`^model ${type} \\{`, 'm').test(SCHEMA)) continue; // одиночная связь
      scalars.push(field);
    }
    expect(scalars.length).toBeGreaterThan(20);
    const unaccounted = scalars.filter(
      (f) => !EXPORTED_USER_PROFILE_FIELDS.includes(f) && !(f in USER_PROFILE_EXCLUSIONS),
    );
    expect(unaccounted).toEqual([]);
  });

  it('поля анкеты перечислены поимённо, а не «всё, кроме»', () => {
    expect(EXPORTED_USER_PROFILE_FIELDS).toContain('religion');
    expect(EXPORTED_USER_PROFILE_FIELDS).toContain('city');
    expect(EXPORTED_USER_PROFILE_FIELDS).toContain('privacyProcessingMode');
    // Заметки модератора и наша догадка о стране — не ответы человека.
    expect(EXPORTED_USER_PROFILE_FIELDS).not.toContain('restrictedNote');
    expect(EXPORTED_USER_PROFILE_FIELDS).not.toContain('blockedNote');
    expect(EXPORTED_USER_PROFILE_FIELDS).not.toContain('ipCountryCode');
    for (const f of ['restrictedNote', 'blockedNote', 'ipCountryCode']) {
      expect(USER_PROFILE_EXCLUSIONS[f]).toBeDefined();
    }
  });

  it('причины написаны для человека, а не пометкой «служебное»', () => {
    const all = { ...USER_EXPORT_EXCLUSIONS, ...USER_PROFILE_EXCLUSIONS };
    const tooShort = Object.entries(all).filter(([, r]) => r.length < 40);
    expect(tooShort).toEqual([]);
    const withoutExplanation = Object.entries(all).filter(([, r]) => !/—|:/.test(r));
    expect(withoutExplanation).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: утверждение «все связи на User каскадные» проверено, а не принято на слово', () => {
    const fks = userFkModels();
    expect(fks.length).toBeGreaterThanOrEqual(16);
    const notCascade = fks.filter((f) => f.onDelete !== 'Cascade');
    expect(notCascade).toEqual([]);
    // Комментарий в сервисе называет число — оно не должно разойтись с
    // тем, что в схеме на самом деле.
    expect(SERVICE).toContain(`все ${fks.length} связей на User каскадные`);
  });
});
