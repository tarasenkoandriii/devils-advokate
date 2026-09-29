// Пункт [latest-migration-was-from-memory] 2026-09-24.
//
// НАЙДЕННОЕ. Диагностика схемы — сообщение, которое оператор читает,
// когда прод уже не работает, — называла файл ПО ПАМЯТИ: «последняя —
// voice_reply_processing_2026_09_02.sql». Файл от 2 сентября; ручных
// миграций после него одиннадцать, до 24 сентября включительно.
//
// И утверждение было неверно ПО РОДУ: сообщение про «значение
// перечисления, которого база не знает» называло ОДИН файл, а
// `ALTER TYPE … ADD VALUE` есть в ДВУХ. Ошибка от первого отправляла
// оператора чинить второй.
//
// ПРЕЦЕДЕНТ СТОЯЛ В СОСЕДНЕМ ФАЙЛЕ И БЫЛ ЗАПИСАН СЛОВАМИ.
// `expected-cron-jobs.ts`: «Синхронность с SQL-файлами держит НЕ
// ДИСЦИПЛИНА, А ТЕСТ… иначе список снова отстанет от реальности, как
// отстал EXPECTED_SCHEDULES». Тот же каталог, тот же модуль — и рядом
// имя, взятое из памяти.
//
// ПРАВИЛО: ни одно имя миграции в коде не написано от руки без сверки с
// каталогом; реестр не отстаёт от каталога ни в одну сторону.

import * as fs from 'fs';
import * as path from 'path';
import { MANUAL_MIGRATIONS, enumMigrations, latestManualMigration, latestOf } from '../admin-db-state/manual-migrations';
import { VOICE_REPLY_MIGRATION } from '../common/enum-migration-lag';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'manual-migrations');
const API_SRC = path.join(__dirname, '..');

function filesOnDisk(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('pg_cron'))
    .sort();
}

function sql(file: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

describe('[latest-migration-was-from-memory] реестр миграций не отстаёт от каталога', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: реестр и каталог совпадают в обе стороны', () => {
    // В одну сторону — новая миграция без записи; в другую — запись,
    // пережившая свой файл. Обе одинаково делают реестр декларацией.
    expect(MANUAL_MIGRATIONS.map((m) => m.file).sort()).toEqual(filesOnDisk());
  });

  it('КЛЮЧЕВОЙ ТЕСТ: названы ВСЕ миграции, добавляющие значения перечислений', () => {
    const fromDisk = filesOnDisk().filter((f) => /ALTER TYPE[\s\S]*ADD VALUE/i.test(sql(f)));
    expect(enumMigrations().map((m) => m.file).sort()).toEqual(fromDisk.sort());
    // Их действительно две: называть одну — отправлять чинить не то.
    expect(fromDisk.length).toBeGreaterThan(1);
  });

  it('проба каждой миграции подтверждается её собственным SQL', () => {
    const mismatched: string[] = [];
    for (const m of MANUAL_MIGRATIONS) {
      const body = sql(m.file);
      if (m.probe.kind === 'column') {
        const re = new RegExp(`ADD COLUMN[^;]*"?${m.probe.column}"?`, 'i');
        if (!re.test(body)) mismatched.push(`${m.file}: колонки ${m.probe.column} нет в файле`);
      } else if (m.probe.kind === 'enumValue') {
        if (!new RegExp(`ADD VALUE[^;]*'${m.probe.value}'`, 'i').test(body)) {
          mismatched.push(`${m.file}: значения ${m.probe.value} нет в файле`);
        }
      } else if (/ADD COLUMN/i.test(body) || /ADD VALUE/i.test(body)) {
        mismatched.push(`${m.file}: помечена как непроверяемая, но добавляет колонку или значение`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('у каждой миграции сказано, что без неё не работает', () => {
    for (const m of MANUAL_MIGRATIONS) {
      expect(m.breaksWhenMissing.length).toBeGreaterThan(30);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одно имя миграции в коде не написано мимо реестра', () => {
    const known = new Set([...filesOnDisk(), ...fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('pg_cron'))]);
    const strays: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '__tests__'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          // Имя файла миграции, написанное строкой прямо в коде.
          for (const m of source.matchAll(/'([\w-]+\.sql)'/g)) {
            if (!known.has(m[1])) strays.push(`${path.relative(API_SRC, full)}: ${m[1]}`);
          }
        }
      }
    };
    walk(API_SRC);
    expect(strays).toEqual([]);
  });

  it('имя, оставленное дословно, совпадает с реестром', () => {
    // Точка, знающая своё перечисление, вправе назвать свою миграцию —
    // но не вправе разойтись с каталогом.
    expect(MANUAL_MIGRATIONS.some((m) => m.file === VOICE_REPLY_MIGRATION)).toBe(true);
    expect(enumMigrations().some((m) => m.file === VOICE_REPLY_MIGRATION)).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «последняя» не зависит от порядка записей в реестре', () => {
    // Первая версия этого теста прошла бы и со сломанным извлечением
    // даты: самая новая миграция стоит в реестре последней, и `.at(-1)`
    // случайно давал верный ответ. Порядок здесь нарочно другой.
    const files = MANUAL_MIGRATIONS.map((m) => m.file);
    expect(latestOf([...files].reverse())).toBe(latestManualMigration());
    expect(latestOf([...files].sort())).toBe(latestManualMigration());
    // И прямая проба на самом извлечении: дата решает, место — нет.
    expect(latestOf(['zzz_2026_01_01.sql', 'aaa_2026_12_31.sql'])).toBe('aaa_2026_12_31.sql');
    expect(latestOf(['aaa_2026_12_31.sql', 'zzz_2026_01_01.sql'])).toBe('aaa_2026_12_31.sql');
  });

  it('«последняя» выводится из реестра, а не помнится', () => {
    const newest = filesOnDisk()
      .filter((f) => /\d{4}_\d{2}_\d{2}\.sql$/.test(f))
      .sort((a, b) => (/(\d{4}_\d{2}_\d{2})/.exec(a)![1]).localeCompare(/(\d{4}_\d{2}_\d{2})/.exec(b)![1]))
      .at(-1);
    expect(latestManualMigration()).toBe(newest);
    // И это уже НЕ тот файл, что был записан в сообщении по памяти.
    expect(latestManualMigration()).not.toBe('voice_reply_processing_2026_09_02.sql');
  });
});
