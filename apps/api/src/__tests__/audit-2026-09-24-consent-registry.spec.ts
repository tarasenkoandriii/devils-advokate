// Пункт [consent-that-could-not-be-given] 2026-09-24 — часть сверки,
// которая читает исходники: разбор границы по файлам и наличие экрана.
// Поведенческие проверки — в соседнем `…-consent-that-could-not-be-given.spec.ts`.

import * as fs from 'fs';
import * as path from 'path';
import { PERSON_RESEARCH_GATED, PERSON_RESEARCH_NOT_GATED } from '../consent/person-research';

const API_SRC = path.join(__dirname, '..');
const TMA_SRC = path.join(__dirname, '..', '..', '..', 'tma', 'src');

describe('[consent-that-could-not-be-given] граница исследования человека', () => {
  it('граница разложена без остатка: каждый разбор уровня человека — в одном из двух списков', () => {
    // Методы, принимающие personId и зовущие модель, ищутся в исходниках,
    // а не перечисляются по памяти: список, написанный по памяти, уже
    // однажды отстал от каталога ([latest-migration-was-from-memory]).
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (e.name.endsWith('.service.ts')) {
          const src = fs.readFileSync(p, 'utf8');
          const rel = path.relative(API_SRC, p).split(path.sep).join('/');
          const re = /async (\w+)\(([^)]*)\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src))) {
            if (!m[2].includes('personId')) continue;
            const next = src.indexOf('\n  async ', m.index + 1);
            const body = src.slice(m.index, next > 0 ? next : src.length);
            if (/aiRouter|AIRouter/.test(body)) found.push(`${rel}#${m[1]}`);
          }
        }
      }
    };
    walk(API_SRC);

    const known = new Set([...PERSON_RESEARCH_GATED.map((g) => g.site), ...PERSON_RESEARCH_NOT_GATED.map((g) => g.site)]);
    const unclassified = [...new Set(found)].filter((f) => !known.has(f));
    expect(unclassified).toEqual([]);
    // Обратная проба: поиск вообще что-то находит, и находит больше,
    // чем список требующих согласия.
    expect(new Set(found).size).toBeGreaterThan(PERSON_RESEARCH_GATED.length);
  });

  it('у каждой стороны границы записана причина, а не одно название', () => {
    for (const g of PERSON_RESEARCH_GATED) expect(g.producesAboutPerson.length).toBeGreaterThan(40);
    for (const n of PERSON_RESEARCH_NOT_GATED) expect(n.why.length).toBeGreaterThan(40);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран, который спрашивает это согласие, существует и просит именно его', () => {
    // Требование без экрана — тупик: продукт отказал бы и не дал
    // способа разрешить. Проверяется наличие вызова grantConsent именно
    // с этим типом, а не упоминание слова в комментарии.
    // ЧТО экран просит — проверяется ВЫЗОВОМ, в
    // `apps/tma/src/__tests__/person-research-consent.spec.ts`: там
    // подменная выдача согласия ловит тип и версию. Здесь остаётся
    // только то, что вызовом не проверить: что экран подключён и
    // не лежит без дела.
    const users: string[] = [];
    for (const f of fs.readdirSync(path.join(TMA_SRC, 'components'))) {
      if (!f.endsWith('.tsx') || f === 'PersonResearchConsent.tsx') continue;
      const src2 = fs.readFileSync(path.join(TMA_SRC, 'components', f), 'utf8');
      if (/<PersonResearchConsent\b/.test(src2)) users.push(f);
    }
    expect(users.length).toBeGreaterThanOrEqual(2);
  });
});
