// Сверка экспорта данных 2026-09-04 — «выгрузить всё» и что это значит.
//
// Экспорт (`GET /privacy/export`, GDPR art. 20) написан честно: он отдаёт
// данные и перечисляет, чего в выгрузке НЕТ. Но список писался один раз, а
// продукт вырос: из 42 связей проекта в выгрузку попадали 19, про
// остальные 23 не было сказано ничего — ни в данных, ни в списке
// исключений. Человек получал файл, который выглядит полным.
//
// Это тот же дефект, что обрезанный список без подписи (заход
// [page-limits]) и молчаливое удаление проекта (заход [project-deletion]),
// только про выгрузку собственных данных: **пробел не должен выглядеть как
// полнота**.
//
// И причина у него системная: список, который никто не обязан обновлять,
// отстаёт молча. Поэтому здесь не только дополненный экспорт, но и реестр
// (`export-scope.ts`) плюс этот тест: каждая связь проекта обязана быть
// либо в выгрузке, либо в исключениях с причиной. Новая связь в схеме
// уронит тест — отстать молча больше нельзя, можно только сознательно.

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  EXPORTED_AT_TOP_LEVEL,
  EXPORTED_PROJECT_RELATIONS,
  EXPORT_EXCLUSIONS,
} from '../privacy-center/export-scope';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const EXPORT_SOURCE = readFileSync(
  join(__dirname, '..', 'privacy-center', 'privacy-center.service.ts'),
  'utf8',
);

/** Связи-списки модели Project прямо из схемы — источник истины здесь она,
 * а не список в коде. */
function projectRelations(): string[] {
  const model = /^model Project \{([\s\S]*?)^\}/m.exec(SCHEMA)?.[1] ?? '';
  return model
    .split('\n')
    .map((line) => /^\s+(\w+)\s+(\w+)\[\]/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

describe('Экспорт данных: выгрузка не может молча отстать от продукта', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: про каждую связь проекта сказано — либо она в выгрузке, либо в исключениях с причиной', () => {
    const unaccounted = projectRelations().filter(
      (rel) =>
        !EXPORTED_PROJECT_RELATIONS.includes(rel) &&
        !(rel in EXPORT_EXCLUSIONS) &&
        !(rel in EXPORTED_AT_TOP_LEVEL),
    );
    expect(unaccounted).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: то, что объявлено выгружаемым, действительно запрашивается у базы', () => {
    // Иначе реестр стал бы декларацией: список говорит «выгружаем», а
    // запрос этого не делает. Ровно та подмена, которую нашла сверка мест
    // применения — правило, записанное и не применённое.
    const exportBody = EXPORT_SOURCE.slice(EXPORT_SOURCE.indexOf('async exportData'));
    const declaredButNotQueried = EXPORTED_PROJECT_RELATIONS.filter(
      (rel) => !new RegExp(`\\b${rel}:\\s*(true|\\{)`).test(exportBody),
    );
    expect(declaredButNotQueried).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: причина исключения написана для человека, а не пометкой «служебное»', () => {
    // Список исключений показывается человеку в самой выгрузке. Строка
    // вроде «internal» там бесполезна: он не может по ней понять, потерял
    // ли он что-то важное.
    const tooShort = Object.entries(EXPORT_EXCLUSIONS).filter(([, reason]) => reason.length < 40);
    expect(tooShort).toEqual([]);
    const withoutExplanation = Object.entries(EXPORT_EXCLUSIONS).filter(
      ([, reason]) => !/—|:/.test(reason),
    );
    expect(withoutExplanation).toEqual([]);
  });

  it('чужие тексты публичного обсуждения в выгрузку не идут — и это названо прямо', () => {
    // Это не техническое ограничение, а решение: заявки и комментарии
    // написали другие люди. Выгружать их вместе со своими данными значило
    // бы отдавать владельцу проекта чужое.
    for (const rel of ['publicSubmissions', 'publicComments', 'publicParticipants']) {
      expect(EXPORT_EXCLUSIONS[rel]).toBeDefined();
      expect(EXPORT_EXCLUSIONS[rel]).toMatch(/друг|не ваши|другими/i);
    }
  });

  it('весь домен найма теперь в выгрузке: это содержание работы человека, а не служебные отметки', () => {
    for (const rel of ['termsSheets', 'clientBriefs', 'clientReports', 'employerDossiers']) {
      expect(EXPORTED_PROJECT_RELATIONS).toContain(rel);
    }
  });

  it('то, что выгружается отдельным разделом, действительно есть в выгрузке — а не числится выгруженным', () => {
    const exportBody = EXPORT_SOURCE.slice(EXPORT_SOURCE.indexOf('async exportData'));
    const missing = Object.keys(EXPORTED_AT_TOP_LEVEL).filter((rel) => !exportBody.includes(rel));
    expect(missing).toEqual([]);
  });

  it('проверке есть что проверять: связей у проекта действительно много', () => {
    expect(projectRelations().length).toBeGreaterThan(30);
  });
});
