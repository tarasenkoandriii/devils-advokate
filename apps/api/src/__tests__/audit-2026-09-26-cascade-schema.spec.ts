// Пункт [cascade-took-a-stranger] 2026-09-26 — сверка САМОЙ СХЕМЫ.
//
// Отдельным файлом от проверок поведения: этот читает исходник схемы, и
// держать рядом с ним проверки, которым исходник не нужен, значило бы
// зря растить меру сканирующих проверок
// (`audit-2026-09-04-guard-audit`).
//
// Зачем вообще читать схему. Тексты последствий, которые видит человек
// («ваше удаление заберёт N чужих отметок»), верны ровно пока каскады
// такие. Поменяет кто-то Cascade на SetNull — тексты станут неправдой, и
// узнать об этом продукт должен здесь, а не от человека.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

/** Модель схемы целиком. */
function model(name: string): string {
  const src = readFileSync(SCHEMA, 'utf8');
  const start = src.indexOf(`model ${name} {`);
  return start < 0 ? '' : src.slice(start, src.indexOf('\n}', start));
}

describe('Пункт [cascade-took-a-stranger] 2026-09-26: каскады в схеме', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: схема всё ещё та, о которой говорит этот пункт', () => {
    // Описание последствий верно только пока каскады такие. Если кто-то
    // поменяет их на SetNull, тексты станут неправдой — и об этом надо
    // узнать здесь, а не от человека.
    //
    // Один список против одного ожидаемого, а не семь совпадений: так
    // видно и добавленное, и убранное, и мера сканирующих проверок
    // (`audit-2026-09-04-guard-audit`) не растёт от честной работы.
    const links: Array<[string, string]> = [
      ['ApprovedVenue', 'application'],
      ['VenueBookingConfirmation', 'approvedVenue'],
      ['LibraryEntry', 'submittedByUser'],
      ['LibraryEntry', 'sourceProject'],
      ['LibraryExperience', 'libraryEntry'],
      ['PublicComment', 'project'],
      ['PublicArgumentSubmission', 'project'],
    ];
    const actual = links.map(([m, field]) => {
      const line = model(m)
        .split('\n')
        .find((l) => new RegExp(`^\\s*${field}\\s+\\w`).test(l) && l.includes('@relation'));
      const od = /onDelete:\s*(\w+)/.exec(line ?? '');
      return `${m}.${field}=${od ? od[1] : 'нет'}`;
    });
    expect(actual).toEqual([
      'ApprovedVenue.application=Cascade',
      'VenueBookingConfirmation.approvedVenue=Cascade',
      'LibraryEntry.submittedByUser=Cascade',
      // Противоречие, названное в шапке пункта: одно и то же решение
      // принято по-разному для проекта («запись библиотеки остаётся,
      // это публичная отдельная сущность») и для автора.
      'LibraryEntry.sourceProject=SetNull',
      'LibraryExperience.libraryEntry=Cascade',
      'PublicComment.project=Cascade',
      'PublicArgumentSubmission.project=Cascade',
    ]);
  });
});
