// Сверка 2026-09-06 — у факта о человеке есть область видимости, и её
// читал один сервис из одиннадцати.
//
// ЧТО ЭТО ЗА ПОЛЕ. `PersonFact.scope` объявлен в schema.prisma с
// четырьмя значениями, и у каждого написано, что оно значит:
//
//   PROJECT (по умолчанию) — «факт виден только в проекте, где получен»
//   PERSON_GLOBAL          — «явный перенос пользователем, не автоматически»
//   PRIVATE_TO_USER        — «НЕ ПУБЛИКУЕТСЯ НИ ПРИ КАКИХ ОБСТОЯТЕЛЬСТВАХ»
//   PUBLIC_DERIVED_ONLY    — «из факта можно построить Argument, сам факт не публикуется»
//
// НАЙДЕННОЕ. Места, читающие факты, — одиннадцать. Область видимости
// соблюдал ОДИН, `SteelmanService`, и ровно так, как поле задумано.
// Остальные брали `where: { personId, status: 'ACTIVE' }`. То есть
// запись, помеченную человеком как «не публикуется ни при каких
// обстоятельствах», продукт отправлял модели наравне с остальными — в
// поиск прецедентов, в гипотезы о мотивах, в портрет собеседника, в
// карту фигурантов, в советы планировщика.
//
// ПОЧЕМУ ЭТО ТОТ ЖЕ КЛАСС, ЧТО [source-collapse]. Тот пункт нашёл, что
// ПОМЕТКА происхождения факта терялась по дороге к модели, и починил
// её общим модулем. Но чинил он, КАК факты подписаны, и не трогал,
// КАКИЕ выбраны. Вторая половина того же поля осталась неприменённой —
// а заголовок того самого модуля уже содержит нужные слова: «правило
// есть, просто не везде».
//
// И ОТДЕЛЬНО СТОИТ ЗАПОМНИТЬ: правка не уронила НИ ОДНОГО теста. То
// есть область видимости не была покрыта ничем — ни одним тестом ни в
// одном из десяти мест. Поэтому проверки ниже поведенческие: они
// смотрят, КАКОЙ ЗАПРОС сервис делает, а не что написано в исходнике.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
// Правила НА ДАННЫХ вынесены в audit-2026-09-06-scope-not-applied-rule.spec.ts
// — см. объяснение там: метапроверка считает по файлу, и проверки на
// данных рядом с `readFileSync` завышали счёт «опоры на текст».

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Ловит `where`, с которым сервис пошёл в базу: проверяем ЗАПРОС, а не
 * текст файла. */

describe('Сверка [scope-not-applied]: область видимости факта — правило, а не украшение', () => {
  describe('второго правила не будет', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: каждое чтение фактов либо идёт через помощник, либо названо исключением', () => {
      // Исключения — места, где факты показываются ИХ ЖЕ АВТОРУ, а не
      // уходят в разбор: карточка человека и напоминание о том, что
      // запись устарела. Прятать от человека его собственные записи
      // область видимости не просит — она про то, что покидает проект.
      const ownerFacing = [
        'person-facts/person-facts.service.ts',
        'stale-fact/stale-fact.service.ts',
        'privacy-center/privacy-center.service.ts', // выгрузка своих данных
        'common/fact-scope.ts',
      ];
      const offenders: string[] = [];
      for (const f of tsFiles(API_SRC)) {
        const rel = f.slice(API_SRC.length + 1).split('\\').join('/');
        if (ownerFacing.includes(rel)) continue;
        const code = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        // Только факты О ЧЕЛОВЕКЕ: у фактов о КОМПАНИИ
        // (`EmployerDossierFact`) поля `scope` нет вовсе, и первая
        // версия правила зацепила их по общему `facts: true` — имя
        // включения не признак, признак это модель.
        const readsFacts =
          /personFact\.findMany\(/.test(code) || /person:\s*\{\s*include:\s*\{\s*facts/.test(code);
        if (!readsFacts) continue;
        if (!/FactsScopeWhere\(/.test(code)) offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });

    it('проба: новое чтение фактов без помощника правилом ловится', () => {
      const offender = "await this.prisma.personFact.findMany({ where: { personId, status: 'ACTIVE' } });";
      expect(/personFact\.findMany\(/.test(offender)).toBe(true);
      expect(/FactsScopeWhere\(/.test(offender)).toBe(false);
    });

    /** ПРАВИЛО СУЖЕНО ПО ХОДУ СВЕРКИ. Первая версия искала любое
     * `facts: true` и сработала на досье КОМПАНИИ
     * (`EmployerDossierFact`) — у тех фактов поля `scope` нет вовсе.
     * Имя включения не признак; признак — модель, к которой оно
     * относится. Здоровый файл не тронут. */
    it('проба наоборот: факты о компании правилом НЕ ловятся', () => {
      const companyFacts = "this.prisma.employerDossier.findFirst({ include: { facts: true, representatives: true } })";
      expect(/personFact\.findMany\(/.test(companyFacts)).toBe(false);
      expect(/person:\s*\{\s*include:\s*\{\s*facts/.test(companyFacts)).toBe(false);
    });

    /** «Образец зовёт помощник» проверяется ПОВЕДЕНИЕМ: steelman.service.spec.ts
     * прогоняет реальный сервис с фактом чужого проекта и с фактом
     * `PRIVATE_TO_USER` и смотрит, что ни один не дошёл до промпта.
     * Текстовые двойники убраны — дублировать поведенческий тест
     * текстом ровно то, против чего стоит проверка проверок. Правило
     * «второй копии условия не будет» держит обход дерева выше: он
     * требует, чтобы каждое чтение шло через помощник. */
  });
});
