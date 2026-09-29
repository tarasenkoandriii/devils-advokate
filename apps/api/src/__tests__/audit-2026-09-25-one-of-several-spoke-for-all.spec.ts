// Пункт [one-of-several-spoke-for-all] 2026-09-25 — «одно из» говорило
// от имени всех.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Не «у всех findFirst есть orderBy» — такое
// правило кричало бы на сто двадцать шесть мест, из которых почти все
// в порядке: проверка существования не зависит от того, какая строка
// нашлась. Проверяется узкое: НИКТО не берёт досье компании запросом,
// который может вернуть одно из нескольких. Досье выбрано предметом
// правила не по вкусу — это единственная сущность, у которой (а) схема
// допускает несколько на проект и (б) её содержимое подписывает текст,
// уходящий человеку.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

/** Места, которым брать досье поштучно МОЖНО, и почему. */
const ALLOWED: Array<{ file: string; why: string }> = [
  {
    file: 'client-brief/client-brief.service.ts',
    why: 'assertCompanyIdentified: смотрит только на ФАКТ существования досье, содержимое найденной строки не используется вовсе',
  },
  {
    file: 'employer-hiring/employer-hiring.service.ts',
    why: 'та же проверка «компания указана» существованием; показ компании на хабе переведён на findMany выше по файлу',
  },
  {
    file: 'employer-hiring/engagement.service.ts',
    why: 'проверка «компания указана» перед выдачей ссылки агентству: содержимое досье в ответ не попадает',
  },
  {
    file: 'employer-dossier/employer-dossier.service.ts',
    why: 'проверки дубля при создании: смотрят на САМ ФАКТ существования и отдают id найденного, чтобы человек открыл уже созданное',
  },
  {
    file: 'employer-hiring/offer-exchange.service.ts',
    why: 'поиск КОПИИ досье в проекте-получателе по коду реестра или домену — адресный запрос об одной компании, а не выбор из нескольких',
  },
  {
    file: 'vacancy-posting/vacancy-posting.service.ts',
    why: 'проверка «компания указана» существованием; юрисдикция переведена на findMany по всем досье выше по файлу',
  },
  {
    file: 'employer-dossier/single-dossier.ts',
    why: 'сам помощник: он и есть то место, где несколько досье превращаются в честный ответ «их несколько»',
  },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') walk(p);
      } else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function dossierPicks(allowed: Set<string>): string[] {
  const found: string[] = [];
  for (const file of tsFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (allowed.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/employerDossier\.(findFirst|findUnique)\(/.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

describe('[one-of-several-spoke-for-all] досье компании не выбирается за человека', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: поштучной выборки досье нет нигде, кроме названных мест', () => {
    expect(dossierPicks(new Set(ALLOWED.map((a) => a.file)))).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: тот же проход без списка разрешённых находит ровно их', () => {
    // Иначе пустой список выше означал бы не порядок, а сломанный
    // разбор — ошибка, на которой этот ряд сверок себя уже ловил.
    const found = new Set(dossierPicks(new Set()).map((f) => f.split(':')[0]));
    expect([...found].sort()).toEqual(
      ALLOWED.filter((a) => a.file !== 'employer-dossier/single-dossier.ts').map((a) => a.file).sort(),
    );
  });

  it('у каждого разрешённого места записана причина', () => {
    for (const a of ALLOWED) {
      expect(fs.existsSync(path.join(SRC, a.file))).toBe(true);
      expect(a.why.length).toBeGreaterThan(40);
    }
  });

  // Проверка САМОЙ ФОРМУЛИРОВКИ (что человеку названы компании и
  // сказано, что делать) файлов не читает и живёт отдельно —
  // `…-many-companies-message.spec.ts`: мера «проверок по тексту
  // исходника» считает файл целиком.
});
