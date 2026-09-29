// Пункт [coverage-report-outlived-the-product] 2026-09-24.
//
// НАЙДЕННОЕ. `SANDBOX-COVERAGE.md` — документ, по которому владелец
// решает, что прогонять после деплоя. Он говорил «dispatch во все 6
// доменов» и приводил таблицу из шести строк. Доменов в песочнице
// ВОСЕМЬ: добавились поиск работы и наём работодателем, и оба покрыты
// маршрутами песочницы.
//
// Причём комментарий в самой песочнице называет поиск работы «седьмым
// доменом» и датирован ТЕМ ЖЕ ДНЁМ, что отчёт. Текст был неверен в день,
// когда его писали.
//
// ЧЕМ ЭТО ХУЖЕ УСТАРЕВШЕГО КОММЕНТАРИЯ. Последний раздел отчёта —
// инструкция: «пройти панель до жемчужины» по каждому домену. По ней
// два домена из восьми не прогонялись бы вовсе, а молчание отчёта
// читалось бы как «там нечего прогонять». Ровно та форма, которой занят
// весь этот ряд сверок: ПРОБЕЛ ВЫГЛЯДИТ КАК ПОЛНОТА.
//
// ПРАВИЛО: документ, который перечисляет домены, обязан перечислять их
// ВСЕ — иначе он не отчёт, а список того, что кто-то вспомнил.

import * as fs from 'fs';
import * as path from 'path';
import { DOMAIN_MODES } from '../admin-domains/admin-domains.service';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const API_SRC = path.join(__dirname, '..');

/** Домены, у которых в песочнице есть собственные маршруты. Считается
 * по контроллеру, а не по памяти: реестр, написанный по памяти, уже
 * однажды назвал четыре несуществующих метода. */
function sandboxDomains(): string[] {
  const controller = fs.readFileSync(path.join(API_SRC, 'admin-sandbox', 'admin-sandbox.controller.ts'), 'utf8');
  return [...Object.keys(DOMAIN_MODES)].filter((domain) => controller.includes(`'${domain}/`));
}

const REPORT = path.join(REPO, 'SANDBOX-COVERAGE.md');

/** Подписи доменов на операторском экране. */
function screenTitles(): string[] {
  const page = fs.readFileSync(path.join(REPO, 'apps', 'admin', 'src', 'app', 'domains', 'page.tsx'), 'utf8');
  const m = /const TITLES: Record<string, string> = \{([^}]*)\}/.exec(page);
  if (!m) return [];
  return [...m[1].matchAll(/'?([\w-]+)'?\s*:/g)].map((x) => x[1]);
}

describe('[coverage-report-outlived-the-product] отчёт о покрытии не отстаёт от продукта', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: каждый домен песочницы назван в отчёте о покрытии', () => {
    const report = fs.readFileSync(REPORT, 'utf8');
    // Отчёт пишется словами, не ключами, поэтому сверяем по названию
    // домена из операторского экрана — единственному месту, где у ключа
    // есть человеческое имя.
    const titles = Object.fromEntries(
      [...fs.readFileSync(path.join(REPO, 'apps', 'admin', 'src', 'app', 'domains', 'page.tsx'), 'utf8')
        .matchAll(/'?([\w-]+)'?:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
    );
    const missing = sandboxDomains().filter((d) => {
      const title = titles[d];
      return !title || !report.includes(title);
    });
    expect(missing).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого домена сервера есть подпись на операторском экране', () => {
    // Иначе восьмой домен рисуется машинным ключом — тот же дефект, что
    // разбирал пункт [draft-spoke-machine], только на экране оператора.
    const titled = screenTitles();
    const missing = Object.keys(DOMAIN_MODES).filter((d) => !titled.includes(d));
    expect(missing).toEqual([]);
  });

  it('обратная проба: разбор действительно находит домены песочницы, а не пустоту', () => {
    const found = sandboxDomains();
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toContain('employer-hiring');
    expect(found).toContain('job-search');
  });

  it('поправка записана, а прежнее утверждение оставлено датированной записью', () => {
    const report = fs.readFileSync(REPORT, 'utf8');
    expect(report.includes('ПОПРАВКА, Пункт [coverage-report-outlived-the-product]')).toBe(true);
    // Прежнее «6» не стёрто, а зачёркнуто: запись о том, что было
    // заявлено, дороже чистого текста.
    expect(report.includes('~~6~~')).toBe(true);
  });

  it('раздел «осознанно за кадром» не пуст — иначе отчёт обещает полноту', () => {
    const report = fs.readFileSync(REPORT, 'utf8');
    const section = report.slice(report.indexOf('## Что осталось за кадром'));
    expect(section.length).toBeGreaterThan(200);
    // Список — обещание: всё, чего в нём нет, читается как покрытое.
    expect(section.includes('проверен целиком 2026-09-24')).toBe(true);
  });
});
