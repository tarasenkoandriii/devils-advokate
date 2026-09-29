// Сверка 2026-09-06 — срок объявлен, но не наступает.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [job-died-quietly] закрыл ожидание
// без выхода — состояние, из которого нет дороги. Здесь противоположное:
// состояние, которое должно КОНЧАТЬСЯ САМО, и не кончается.
//
// ИЗМЕРЕНИЕ. Восемь моделей несут `expiresAt`. У каждой — от одного до
// пяти входов, и проверка срока написана по месту, одной строкой,
// скопированной столько раз, сколько входов. Так работает ровно до тех
// пор, пока копий не станет на одну больше, чем помнит автор.
//
// НАЙДЕНО ТРИ МЕСТА, И ПЕРВОЕ — САМОЕ ГОВОРЯЩЕЕ.
//
// 1. `EngagementService.assertActive()` принимала `{ status, expiresAt }`
//    и `expiresAt` НЕ ЧИТАЛА. Поле стояло в сигнатуре самой функции:
//    намерение проверить срок записано, проверки нет. Три места зовут
//    её, и все три — передачи данных между работодателем и агентством:
//    доставка отчёта о кандидате, запрос по кандидату, ревью текста
//    вакансии. Заказ с истёкшим сроком считался действующим.
//
//    Это не «забыли добавить проверку». Это проверка, которая ВЫГЛЯДЕЛА
//    существующей: имя функции обещает «active», тип обещает срок, и
//    всякий, кто её звал, был вправе считать вопрос закрытым.
//
// 2. `OfferExchangeService.shareToCandidate()` — единственный из пяти
//    входов по `CandidateShare` без проверки срока. Четыре проверяют.
//    Соискатель ставит ссылке срок сам; после срока в его лист всё
//    равно ложилась копия оффера.
//
// 3. Чеклист закрытия вакансии (Р-14) называет «активными» и заказы, и
//    шеринги, применяя ДВА РАЗНЫХ ослабленных определения — заказы по
//    `status`, шеринги по `revokedAt`, — и ни одно не включает срок.
//    Человеку это не лишняя строка, а просьба развязать то, что
//    развязалось само, и уверенность, что канал открыт, когда он закрыт.
//
// ЧТО СЛЕД ОСТАВИЛИ ФИКСТУРЫ. У двух тестовых заказов `expiresAt` не
// было ВООБЩЕ — при том что поле обязательно по схеме. Данные, спокойно
// обходившиеся без обязательного поля, и есть отпечаток того, что его
// никто не читал.
//
// ПОЧЕМУ ЛЕЧЕНИЕ — ОБЩИЙ ПРЕДИКАТ. Форму «правило было, просто не везде»
// эта сессия встречала шесть раз, и каждый раз лечение одно: сделать
// правило ОДНИМ предметом, который нельзя забыть позвать, потому что
// звать нечего кроме него. `common/term-validity.ts`.
//
// ПОВЕДЕНИЕ, НЕ ТЕКСТ. Все три исхода проверены в
// employer-hiring.service.spec.ts: просроченная ссылка не принимает
// копию оффера (и ни по токену, ни по внутреннему id), просроченный
// заказ отказывает всем трём передачам, а полученное РАНЬШЕ остаётся.
// Здесь — то, что иначе не выразить.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { termIsCurrent, shareIsUsable } from '../common/term-validity';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Сверка [term-never-ends]: объявленный срок наступает', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: предикат срока — это сравнение, а не пересказ', () => {
    const истёкший = { expiresAt: new Date(Date.now() - 1000) };
    const живой = { expiresAt: new Date(Date.now() + 1000) };
    expect(termIsCurrent(истёкший)).toBe(false);
    expect(termIsCurrent(живой)).toBe(true);
    // Граница именно строгая: мгновение истечения — уже не «текущий».
    const ровно = new Date();
    expect(termIsCurrent({ expiresAt: ровно }, ровно)).toBe(false);
    // Отзыв и срок — два независимых основания, и ни одно не поглощает другое.
    expect(shareIsUsable({ ...живой, revokedAt: new Date() })).toBe(false);
    expect(shareIsUsable({ ...истёкший, revokedAt: null })).toBe(false);
    expect(shareIsUsable({ ...живой, revokedAt: null })).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одна функция не принимает срок, чтобы его не прочитать', () => {
    // Правило по последствию, а не по имени: если `expiresAt` попал в
    // ТИП параметра, тело обязано его упомянуть. Именно этот разрыв —
    // «в сигнатуре есть, в теле нет» — и был главной находкой, и именно
    // он не виден ни компилятору, ни глазу при беглом чтении.
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = code(file);
      for (const m of src.matchAll(/\b(\w+)\s*\(\s*\w+\s*:\s*\{[^}]*\bexpiresAt\b[^}]*\}\s*\)\s*(?::[^{]*)?\{/g)) {
        let i = src.indexOf('{', m.index! + m[0].length - 1);
        let depth = 1;
        i++;
        while (i < src.length && depth) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        const body = src.slice(m.index! + m[0].length, i - 1);
        if (!/expiresAt|termIsCurrent|shareIsUsable/.test(body)) {
          offenders.push(`${file.replace(SRC, '')}: ${m[1]}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило выше действительно срабатывает', () => {
    // Обратная проба на синтетическом исходнике: за эту сессию трижды
    // выяснялось, что правило сторожит ровно то, что уже исправлено.
    const probe = 'private assertActive(engagement: { status: S; expiresAt: Date }) { if (engagement.status !== ACTIVE) throw new E(); }';
    const m = [...probe.matchAll(/\b(\w+)\s*\(\s*\w+\s*:\s*\{[^}]*\bexpiresAt\b[^}]*\}\s*\)\s*(?::[^{]*)?\{/g)];
    expect(m).toHaveLength(1);
    const body = probe.slice(m[0].index! + m[0][0].length, probe.lastIndexOf('}'));
    expect(/expiresAt|termIsCurrent|shareIsUsable/.test(body)).toBe(false);
  });

  it('все входы по ссылке соискателя судят о годности одним предикатом', () => {
    // Пять входов, и раньше пятый отличался от четырёх. Теперь условие
    // одно — и переписать его по месту заново стало не к чему.
    const files = [
      'candidate-self-share/candidate-self-share.service.ts',
      'employer-hiring/offer-exchange.service.ts',
      'interview-pool/interview-pool-candidate.service.ts',
    ];
    for (const rel of files) {
      const src = code(join(SRC, rel));
      expect([rel, /termIsCurrent|shareIsUsable/.test(src)]).toEqual([rel, true]);
      // И ни одного переписанного вручную сравнения рядом.
      expect([rel, /expiresAt\s*<\s*new Date\(\)/.test(src)]).toEqual([rel, false]);
    }
  });
});
