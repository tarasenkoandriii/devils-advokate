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

  // Приёмка §11.14 ТЗ job-domain-v2 — ДОБАВЛЕНО АУДИТОМ 2026-09-03: раньше
  // это требование не проверялось ничем. Удаление проекта обязано уносить всё
  // его содержимое: осиротевшая строка с транскриптом или позицией по
  // кандидату переживает удаление проекта и попадает под «данные, которые
  // пользователь считает удалёнными».
  it('у каждой обязательной связи задано поведение при удалении (onDelete)', () => {
    const missing: string[] = [];
    for (const m of models) {
      for (const rel of m.body.matchAll(/@relation\([^)]*fields:\s*\[(\w+)\][^)]*\)/g)) {
        const decl = rel[0];
        const field = rel[1];
        if (/onDelete:/.test(decl)) continue;
        // Необязательная связь (String?) может жить без правила: строка
        // остаётся, ссылка обнуляется — это осознанный случай, а не пробел.
        const line = m.body.match(new RegExp(`^\\s*${field}\\s+\\w+\\??`, 'm'))?.[0] ?? '';
        if (/\?\s*$/.test(line)) continue;
        missing.push(`${m.name}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Приёмка §11.25 ТЗ job-domain-v2 — ДОБАВЛЕНО АУДИТОМ 2026-09-03.
  // Копия, полученная из проекта ДРУГОГО владельца (оффер соискателю, профиль
  // кандидата, отчёт работодателю), связана с источником обычной строкой, а не
  // внешним ключом. Появись здесь @relation с каскадом — удаление аккаунта
  // одной стороны стирало бы документы у другой, которая их себе оставила.
  it('связи между проектами разных владельцев — без FK (иначе каскад уносит чужие копии)', () => {
    const crossProjectFields = ['sharedFromProjectId', 'deliveredToProjectId', 'agencyProjectId'];
    const offenders: string[] = [];
    for (const m of models) {
      for (const field of crossProjectFields) {
        if (!new RegExp(`^\\s*${field}\\s`, 'm').test(m.body)) continue;
        if (new RegExp(`@relation\\([^)]*fields:\\s*\\[${field}\\]`).test(m.body)) offenders.push(`${m.name}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
