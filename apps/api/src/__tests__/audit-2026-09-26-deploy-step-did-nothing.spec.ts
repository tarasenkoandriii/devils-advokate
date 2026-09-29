// Пункт [deploy-step-did-nothing] 2026-09-26 — сверка имён таблиц со
// схемой.
//
// Разбор схемы проверяется на НАСТОЯЩЕМ `schema.prisma`, а не на
// выдуманном куске: вопрос «правильно ли мы читаем `@@map`» имеет смысл
// только против того файла, который мы и читаем. Поведение сверки —
// на собранных руками наборах, где видно оба исхода.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compareSchemaTables,
  declaredTables,
  SCHEMA_TABLES_NOT_CHECKED,
} from '../admin-db-state/schema-tables';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

describe('Пункт [deploy-step-did-nothing] 2026-09-26: таблицы схемы против базы', () => {
  it('проба механизма: настоящая схема разобрана, и таблиц в ней много', () => {
    const declared = declaredTables(SCHEMA);
    // Число точное: молча усохший разбор прошёл бы проверку «> 0»,
    // оставив сверку пустой и потому всегда зелёной.
    expect(declared.length).toBe(169);
    expect(SCHEMA_TABLES_NOT_CHECKED.length).toBe(4);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: `@@map` учтён — иначе половина таблиц «пропала бы» из базы', () => {
    const declared = declaredTables(SCHEMA);
    const byModel = new Map(declared.map((d) => [d.model, d.table]));
    // Модели с `@@map`: имя таблицы отличается от имени модели.
    expect(byModel.get('LibraryEntry')).toBe('library_entries');
    expect(byModel.get('VenueApplication')).toBe('venue_applications');
    expect(byModel.get('ApprovedVenue')).toBe('approved_venues');
    // ИЗМЕРЕНО, и оказалось не так, как я предполагал: `@@map` есть у
    // ВСЕХ 169 моделей. Значит это инвариант схемы, и он полезнее
    // догадки — модель без `@@map` получит имя таблицы в CamelCase,
    // единственная такая среди snake_case, и заметить это будет нечем.
    const unmapped = declared.filter((d) => d.table === d.model);
    expect(unmapped.map((d) => d.model)).toEqual([]);
    // Разбор без `@@map` всё равно обязан работать: Prisma в этом случае
    // берёт имя модели как есть, и подставлять snake_case по догадке
    // нельзя. Проверяется на собранной схеме ниже, где такая модель есть.
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пропавшая таблица названа моделью и таблицей', async () => {
    const schema = 'model Foo {\n  id String @id\n  @@map("foos")\n}\nmodel Bar {\n  id String @id\n}\n';
    const drift = compareSchemaTables(schema, ['foos']);
    expect(drift.missingInDatabase).toEqual([{ model: 'Bar', table: 'Bar' }]);
    // Модель нужна человеку, чтобы найти её в схеме; таблица — чтобы
    // найти её в базе. Одного имени недостаточно ни для того, ни для
    // другого.
    expect(drift.declaredCount).toBe(2);
    expect(drift.observedCount).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сверка идёт В ОБЕ СТОРОНЫ', () => {
    const schema = 'model Foo {\n  id String @id\n  @@map("foos")\n}\n';
    const drift = compareSchemaTables(schema, ['foos', 'leftover_from_db_push']);
    expect(drift.unknownInSchema).toEqual(['leftover_from_db_push']);
    expect(drift.missingInDatabase).toEqual([]);
  });

  it('служебные таблицы за расхождение не считаются', () => {
    // `_prisma_migrations` появится ровно тогда, когда завёдут baseline, —
    // кричать на неё значило бы кричать на правильный шаг.
    const schema = 'model Foo {\n  id String @id\n  @@map("foos")\n}\n';
    const drift = compareSchemaTables(schema, ['foos', '_prisma_migrations', 'spatial_ref_sys']);
    expect(drift.unknownInSchema).toEqual([]);
  });

  it('обратная проба: когда всё совпало — оба списка пусты, а не «похоже, совпало»', () => {
    const schema = 'model Foo {\n  id String @id\n  @@map("foos")\n}\n';
    const drift = compareSchemaTables(schema, ['foos']);
    expect(drift.missingInDatabase).toEqual([]);
    expect(drift.unknownInSchema).toEqual([]);
    // И числа рядом: «совпало» без чисел читается как «сверили пустоту».
    expect([drift.declaredCount, drift.observedCount]).toEqual([1, 1]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чего сверка НЕ проверяет — едет вместе с ответом', () => {
    const drift = compareSchemaTables('model Foo {\n  id String @id\n}\n', ['Foo']);
    expect(drift.notChecked).toEqual(SCHEMA_TABLES_NOT_CHECKED);
    // Иначе «все объявленные таблицы в базе есть» прочитается как «база
    // соответствует схеме», а это разные утверждения.
    for (const line of SCHEMA_TABLES_NOT_CHECKED) {
      expect(line.length).toBeGreaterThan(40);
    }
  });

  it('МЕРА: baseline-миграции по-прежнему нет — и когда появится, об этом узнают здесь', () => {
    // Пункт закрывает не baseline, а то, ради чего он нужен. Появится
    // папка миграций — этот тест покраснеет, и тогда сверку имён таблиц
    // можно будет заменить настоящей сверкой истории.
    const migrations = join(__dirname, '..', '..', 'prisma', 'migrations');
    expect(require('node:fs').existsSync(migrations)).toBe(false);
  });
});
