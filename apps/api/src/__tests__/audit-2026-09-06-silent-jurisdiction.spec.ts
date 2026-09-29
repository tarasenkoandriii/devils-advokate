// Сверка 2026-09-06 — блок о законе исчезал молча.
//
// НАЙДЕННОЕ. `getDisclaimer()` возвращал `null`, когда для пары
// «режим + юрисдикция» ссылок нет, и это было названо «структурним
// сигналом»: экран делал `if (!data) return null`, и блок «Что говорит
// закон» пропадал целиком.
//
// ИЗМЕРЕНО ДО ПРАВКИ: из 36 пар собраны ШЕСТЬ. Остальные тридцать —
// включая ДТП в Украине, семейное право в Украине, всё здоровье и весь
// поиск работы — отдавали пустой экран без единого слова. Для
// украинского пользователя, ради которого продукт и сделан, блок о
// законе не показывался почти никогда.
//
// ЭТО БЫЛО ОСОЗНАННОЕ РЕШЕНИЕ ВЛАДЕЛЬЦА, И ОНО ИЗМЕНЕНО ИМ ЖЕ. Прежний
// комментарий в сервисе сам называл риск: «мовчання про юрисдикцію
// можна прочитати як „тут нема юридичних ризиків“, хоча насправді
// просто ніхто не досліджував». Риск назван верно и реализован
// буквально. Тот же продукт с тех пор закрыл этот изъян везде, где
// нашёл, и даже СБОЙ загрузки этого самого блока получил отдельное
// сообщение (`SectionLoadError`) ровно с доводом «юридические
// ориентиры, исчезнувшие молча, читаются как „этот домен ничем не
// регулируется“». Пробел и сбой здесь — одна ложь умолчанием.
//
// ЧТО СОХРАНЕНО ОТ ПРЕЖНЕГО РЕШЕНИЯ: отвергнут был ПУГАЮЩИЙ флаг «не
// досліджено, зверніться до юриста» на каждом экране. Его нет — есть
// спокойный факт о том, чего продукт не собрал.
//
// ВТОРАЯ НАХОДКА, МЕЛЬЧЕ НА ВИД. Поле называлось `lastVerifiedAt`, и
// экран печатал «проверено 15.01.2026» с подсказкой «если старше года —
// перепроверьте». Никто ничего не проверял в тот день: это дата, когда
// норму вписали. У всех пяти ссылок она была одна и та же и не менялась
// ни разу — процесса перепроверки у продукта нет, а порог «год»
// обещал его.

import { LegalDisclaimerService, seedCoverageSummary, oldestSeededDaysAgo } from '../legal-disclaimer/legal-disclaimer.service';
import { LEGAL_REFERENCE_SEED } from '../legal-disclaimer/legal-reference-seed';
import { readFileSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..');

function fakePrisma(user: any) {
  return { user: { findUnique: async () => user } };
}

function service(user: any) {
  return new LegalDisclaimerService(fakePrisma(user) as any);
}

const NOW = new Date('2026-09-22T12:00:00Z');

describe('[silent-jurisdiction] пробел в юридических ориентирах назван, а не спрятан', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: несобранная пара отдаёт пробел словами, а не null', async () => {
    // Это и есть весь пункт. До правки здесь возвращался null, и блок
    // о законе исчезал с экрана целиком.
    // Бакет OTHER не собран НАМЕРЕННО: он охватывает все прочие
    // юрисдикции мира сразу, и честной ссылки «на все страны, кроме
    // трёх» не существует. Пробел здесь останется — важно, что он
    // НАЗВАН, а не показан пустотой.
    const out = await service({ country: 'BR', countryCode: null, ipCountryCode: null })
      .getDisclaimer('u1', 'INVESTMENT' as any, NOW);
    expect(out).not.toBeNull();
    expect(out.coverage).toBe('not-researched');
    expect(out.bucket).toBe('OTHER');
    expect(out.references).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «не исследовано» НЕ выдаётся за «исследовали, норм нет»', async () => {
    // Различить это нынешним словарём нечем, и называть одно другим —
    // ровно тот изъян, который пункт закрывает. Поэтому у состояния
    // такое имя, а не `no-norms`.
    const out = await service({ country: null, countryCode: null, ipCountryCode: null })
      .getDisclaimer('u1', 'HEALTH' as any, NOW);
    expect(out.bucket).toBe('OTHER');
    expect(out.coverage).toBe('not-researched');
    expect(JSON.stringify(out)).not.toMatch(/no-norms|норм нет|нічого не регулює/i);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: собранная пара отдаёт ссылки и возраст записи', async () => {
    const out = await service({ country: 'UA', countryCode: null, ipCountryCode: null })
      .getDisclaimer('u1', 'DTP' as any, NOW);
    expect(out.coverage).toBe('seeded');
    expect(out.references.length).toBeGreaterThan(0);
    // Возраст считает СЕРВЕР: экран, считающий его сам, однажды
    // посчитает иначе.
    expect(typeof out.seededDaysAgo).toBe('number');
    expect(out.seededDaysAgo).toBe(0); // вписано сегодня
  });

  it('КЛЮЧЕВОЙ ТЕСТ: возраст — по самой СТАРОЙ ссылке списка', async () => {
    // Список настолько свеж, насколько свежа его худшая строка.
    // Считать по самой новой значило бы прятать старую норму за
    // свежей соседкой.
    //
    // Проверяется НА СОБСТВЕННЫХ ДАННЫХ, а не на словаре: пока в
    // словаре у каждой собранной пары даты совпадают, «самая старая» и
    // «самая новая» — одно и то же, и мутация проходит насквозь.
    // Первая версия этого теста ровно так и промахнулась.
    const mixed = [
      { actName: 'a', citation: 'c', summary: 's', sourceUrl: 'https://example.org', seededAt: '2026-09-01' },
      { actName: 'b', citation: 'c', summary: 's', sourceUrl: 'https://example.org', seededAt: '2026-01-15' },
    ];
    expect(oldestSeededDaysAgo(mixed, NOW)).toBe(250);
    expect(oldestSeededDaysAgo([mixed[0]], NOW)).toBe(21);
    expect(oldestSeededDaysAgo([], NOW)).toBeNull();

    const out = await service({ country: 'DE', countryCode: null, ipCountryCode: null })
      .getDisclaimer('u1', 'INTERVIEW_POOL' as any, NOW);
    expect(out.coverage).toBe('seeded');
    expect(out.seededDaysAgo).toBeGreaterThan(200);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: поле называется тем, чем является — датой ЗАПИСИ, не проверки', () => {
    // «Проверено» обещает процесс перепроверки, которого у продукта
    // нет. Мутация «вернуть имя lastVerifiedAt» обязана падать здесь.
    const all = Object.values(LEGAL_REFERENCE_SEED).flatMap((byBucket) => Object.values(byBucket).flat());
    expect(all.length).toBeGreaterThan(0);
    for (const ref of all) {
      expect(typeof (ref as any).seededAt).toBe('string');
      expect((ref as any).lastVerifiedAt).toBeUndefined();
    }
    // И само слово не возвращается в словарь даже необязательным полем:
    // мутация «дописать `lastVerifiedAt?: string` в тип» прошла первую
    // версию этой проверки насквозь — значений-то нет, а дверь открыта.
    // Здесь проверяется ИМЯ, потому что предмет пункта и есть имя.
    const seedSource = readFileSync(join(API_SRC, 'legal-disclaimer/legal-reference-seed.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(seedSource).not.toMatch(/lastVerifiedAt/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждой собранной ссылки есть источник, который можно открыть', () => {
    // Норма без ссылки на источник — это утверждение о законе, которое
    // человеку нечем проверить. Для юридического ориентира это то же,
    // что позиция без цитаты в листе условий.
    const all = Object.values(LEGAL_REFERENCE_SEED).flatMap((byBucket) => Object.values(byBucket).flat());
    const withoutSource = all.filter((r) => !r.sourceUrl);
    expect(withoutSource.map((r) => r.actName)).toEqual([]);
    for (const r of all) expect(r.sourceUrl).toMatch(/^https:\/\//);
  });

  it('ИЗМЕРЕНИЕ: сколько пар собрано из скольких — считается из словаря', () => {
    // Число не записано константой: записанное однажды, оно разойдётся
    // со словарём при первом пополнении. Проверка — точка отсчёта для
    // следующей сверки: пар стало больше, и это видно.
    const { total, seeded } = seedCoverageSummary();
    expect(total).toBe(36);
    // До сверки было 6. Собрано 21: шесть украинских пар в первом
    // заходе и пятнадцать во втором (остальные UA, весь EU, весь US).
    // Несобранными остаются ровно девять — это бакет OTHER у каждого
    // режима, и он не собран намеренно (см. TODO.md).
    expect(seeded).toBe(27);
    expect(total - seeded).toBe(9);
  });

  it('ИЗМЕРЕНИЕ: для украинского пользователя собраны самые дорогие домены', () => {
    // Смысл пополнения был не в числе, а в том, ЧЬИ именно экраны
    // молчали: ДТП и семейное право в Украине — там, где цена ошибки
    // измеряется не удобством.
    for (const mode of ['DTP', 'FAMILY_LAW', 'HEALTH', 'JOB_SEARCH', 'MAJOR_PURCHASE', 'STANDARD']) {
      expect((LEGAL_REFERENCE_SEED as any)[mode].UA.length).toBeGreaterThan(0);
    }
  });
});
