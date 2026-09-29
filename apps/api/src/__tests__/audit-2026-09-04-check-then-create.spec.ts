// Сверка «проверил — и создал» 2026-09-04.
//
// ФОРМА. Метод читает, есть ли уже такая строка, и если нет — создаёт.
// Между чтением и записью проходит время, и второй такой же вызов
// (двойное нажатие, повтор при плохой связи, две вкладки) успевает
// пройти проверку до того, как первый запишет. Проект уже трижды
// закрывал эту форму прицельно — атомарный забор права на отправку
// напоминания, вебхук расшифровки, аренда медиа, голос в публичном
// обсуждении, — но сплошной сверки «где ещё так» не было ни разу.
//
// ИЗМЕРЕНО: 46 мест, где в одном методе читают и создают ОДНУ И ТУ ЖЕ
// модель без транзакции. Дальше важно разделить, потому что исходы
// разные:
//
//  • у модели ЕСТЬ уникальное ограничение — база отвергает вторую
//    вставку, Prisma бросает P2002, и человек получает пятисотку на
//    действии, которое на самом деле УЖЕ УДАЛОСЬ. Данные целы,
//    сообщение врёт;
//  • ограничения НЕТ — обе вставки проходят, появляется дубль, и о нём
//    никто не узнает.
//
// ЧТО ИСПРАВЛЕНО (первая половина — там, где ограничение есть).
//
// 1. `LiveArgumentTrackingService.initialize()` — худший случай сразу по
//    двум причинам. Это самый нагруженный экран продукта, сопровождение
//    ЖИВОГО разговора, и инициализация делала по ДВА обращения к базе на
//    каждый аргумент проекта: двадцать аргументов — сорок запросов, и
//    число росло вместе с проектом человека. Плюс гонка: клиент зовёт
//    инициализацию при каждом входе в режим, двойное нажатие давало два
//    вызова внахлёст, оба проходили проверку и оба вставляли — вторая
//    вставка падала на уникальном `argumentId`. Заменено одним
//    `createMany` со `skipDuplicates`: один запрос вместо 2N, и повтор
//    безвреден по определению.
//
// 2. Вступление в команду рекрутеров и в инвест-группу. Замысел там
//    ИДЕМПОТЕНТНЫЙ — уже состоящий просто получает своё членство
//    обратно, — но реализация оставляла окно, и второй переход по ссылке
//    падал с P2002 вместо «вы уже в команде». Заменено `upsert` с
//    `update: {}`: то же намерение без окна, и роль вступившего раньше
//    повторным переходом не переписывается.
//
// 3. Семь методов «создать конфигурацию домена» (здоровье, ДТП,
//    семейное право, инвестиции, поиск работы, крупная покупка, подбор
//    персонала). Там повтор — ошибка ПО ЗАМЫСЛУ («разбор для этого
//    проекта уже настроен»), и гонку без блокировки не исключить. Но
//    ответ обязан быть один и тот же независимо от того, кто успел
//    раньше: теперь P2002 превращается в ту же понятную фразу, а не в
//    внутреннюю ошибку сервера.
//
//    Попутно там же поймана собственная ошибка: `return this.prisma…`
//    внутри `try` возвращает промис, и отказ базы летит МИМО catch —
//    обработка была бы «поймана» только на бумаге. Исправлено на
//    `return await`.
//
// ЧТО НЕ ИСПРАВЛЕНО И ПОЧЕМУ ЭТО РЕШЕНИЕ ВЛАДЕЛЬЦА. Девять моделей
// уникального ограничения не имеют вовсе: `person`, `personFact`,
// `termsClause`, `transcriptSegment`, `workingMaterial`, `consentRecord`,
// `complianceFlag`, `dtpParticipant`, `familyLawParty`. Там повтор даёт
// тихий дубль, и закрыть это можно только уникальным индексом в базе —
// то есть ещё одной ручной миграцией. Но главное не в миграции: чтобы
// её написать, надо решить, ЧТО СЧИТАТЬ ОДИНАКОВЫМ. Двух людей с именем
// «Иван» человек может завести намеренно; два одинаковых факта об одном
// человеке — почти наверняка ошибка; две одинаковые реплики в
// расшифровке бывают законно. Это решения о продукте, а не о коде, и
// принимать их молча за владельца неправильно — тот же принцип, по
// которому в [page-limits] отложено ограничение частоты, а в
// [audit-trail] — срок хранения журнала.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { BadRequestException } from '@nestjs/common';
import { isUniqueViolation } from '../common/unique-violation';
import { HealthService } from '../health/health.service';

const SRC = join(__dirname, '..');

function services(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : services(full);
    return name.endsWith('.service.ts') ? [full] : [];
  });
}

/** Методы, где читают и создают одну и ту же модель. Разбор грубый по
 * замыслу: он ищет ФОРМУ, а не доказывает гонку — доказательство даёт
 * поведенческий тест на конкретном месте. */
function checkThenCreateSites(): Array<{ file: string; method: string; model: string }> {
  const found: Array<{ file: string; method: string; model: string }> = [];
  for (const file of services()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\n {2}(?:private |public )?async (\w+)\(([\s\S]*?)\n {2}\}\n/g)) {
      const body = m[2];
      const reads = new Set([...body.matchAll(/this\.prisma\.(\w+)\.(?:findUnique|findFirst)\(/g)].map((r) => r[1]));
      const creates = new Set([...body.matchAll(/this\.prisma\.(\w+)\.create\(/g)].map((r) => r[1]));
      for (const model of reads) {
        if (creates.has(model)) found.push({ file: relative(SRC, file), method: m[1], model });
      }
    }
  }
  return found;
}

describe('Проверил — и создал: что будет, если нажать дважды', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: создание конфигурации домена отвечает одинаково, кто бы ни успел первым', async () => {
    // Гонку здесь не исключить без блокировки — и не надо. Надо, чтобы
    // человек читал «уже настроено», а не «внутренняя ошибка сервера».
    const prisma: any = {
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
      healthConfig: {
        // Проверка «уже есть» проходит: в момент чтения записи ещё нет.
        findUnique: async () => null,
        // …а к моменту вставки её успел создать параллельный вызов.
        create: async () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
      },
    };
    const svc = new HealthService(prisma, {} as any, {} as any, {} as any);

    await expect(
      svc.createConfig('u1', 'p1', { goalDescription: 'цель', criteria: [] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ базы ловится по КОДУ, а не по тексту сообщения', () => {
    // Текст зависит от версии драйвера и от языка; код — нет. Проверка по
    // подстроке сломалась бы на первом же обновлении Prisma, и сломалась
    // бы молча: гонка снова начала бы отдавать пятисотку.
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(new Error('Unique constraint failed on the fields: (`projectId`)'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: идемпотентные по замыслу вступления сделаны идемпотентными и в коде', () => {
    // «Вступить туда, где уже состоишь» — не ошибка, а повтор. Значит,
    // и в базе это должно быть одной операцией, а не парой «прочитать,
    // потом вставить».
    for (const rel of [
      'interview-pool/interview-pool-team.service.ts',
      'investment/investment-group.service.ts',
    ]) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(src).toMatch(/\.upsert\(\{/);
      expect(src).toMatch(/update: \{\},/);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: `return await` внутри try — иначе отказ летит мимо catch', () => {
    // Собственная ошибка этого же захода, пойманная до сдачи: `return
    // this.prisma…` возвращает промис, и его отказ не попадает в catch,
    // стоящий рядом. Обработка выглядела бы написанной и не работала.
    const offenders: string[] = [];
    for (const rel of [
      'health/health.service.ts',
      'dtp/dtp.service.ts',
      'family-law/family-law.service.ts',
      'investment/investment.service.ts',
      'job-search/job-search.service.ts',
      'major-purchase/major-purchase.service.ts',
      'interview-pool/interview-pool.service.ts',
    ]) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      if (!/isUniqueViolation/.test(src)) offenders.push(`${rel}: гонка при создании не обработана`);
      if (/try \{\s*\n\s*return this\.prisma\./.test(src)) offenders.push(`${rel}: return без await внутри try`);
    }
    expect(offenders).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько мест читают и создают одну модель в одном методе', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Само по
    // себе оно не приговор: у большинства этих мест есть уникальное
    // ограничение, и худшее, что даёт гонка, — неверное сообщение. Девять
    // моделей без ограничения перечислены в шапке файла; закрыть их —
    // решение о том, что считать одинаковым, то есть решение о продукте.
    //
    // ПОПРАВКА Пункта [check-then-create-2] 2026-09-27: диапазон — мера,
    // а не правило, и из неё не следовало ни какие места вылечены, ни что
    // новое не появилось. Восемь мест действительно стояли
    // невылеченными. Правило теперь живёт отдельно и замкнуто:
    // `audit-2026-09-27-race-population.spec.ts` требует, чтобы У КАЖДОГО
    // места, где гонку видно базе, был ответ в реестре
    // `common/check-then-create.ts`. Диапазон оставлен как есть: он
    // по-прежнему говорит, что разбор не усох до нуля.
    const sites = checkThenCreateSites();
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.length).toBeLessThan(80);
  });
});
