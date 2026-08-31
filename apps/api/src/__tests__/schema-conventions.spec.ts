// Аудит моделей БД 2026-08-30 — конвенции схемы как тест, чтобы регрессии
// ловились на CI, а не следующим аудитом. Читает schema.prisma напрямую.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));

describe('schema.prisma — конвенции', () => {
  it('в схеме есть модели', () => {
    expect(models.length).toBeGreaterThan(100);
  });

  it('каждая модель замаплена на snake_case таблицу (@@map)', () => {
    const missing = models.filter((m) => !/@@map\("/.test(m.body)).map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it('каждая FK-колонка имеет индекс (Postgres не создаёт их автоматически)', () => {
    const missing: string[] = [];
    for (const m of models) {
      const fks = [...m.body.matchAll(/@relation\(fields:\s*\[(\w+)\]/g)].map((x) => x[1]);
      const leading = [...m.body.matchAll(/@@(?:index|unique)\(\[([^\]]*)\]/g)].map((x) => x[1].split(',')[0].trim());
      for (const fk of fks) {
        const line = m.body.match(new RegExp(`^\\s*${fk}\\s.*$`, 'm'))?.[0] ?? '';
        if (/@unique|@id/.test(line) || leading.includes(fk)) continue;
        missing.push(`${m.name}.${fk}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('у каждой модели есть хотя бы одна временная метка', () => {
    const missing = models.filter((m) => !/\bDateTime\b/.test(m.body)).map((m) => m.name);
    expect(missing).toEqual([]);
  });
});
