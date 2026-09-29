// Пункт [decisions-spoke-machine] 2026-09-25 — решения о человеке
// говорили с ним машинными именами и кончались на границе аккаунта.
//
// Поведение проверяется на самой выгрузке (ниже), а здесь ещё и реестр
// подписей: действие, попавшее в журнал и не попавшее в реестр, — это
// строка, которую человек прочитает как идентификатор из кода.

import * as fs from 'fs';
import * as path from 'path';
import { DECISION_LABELS } from '../privacy-center/decision-labels';

const SRC = path.join(__dirname, '..');

/** Имена действий, ВСТРЕЧАЮЩИЕСЯ в коде: и литералами, и константами.
 * Собираются разбором, а не перечисляются — список по памяти уже однажды
 * отстал от каталога ([latest-migration-was-from-memory]). */
function actionsInCode(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') walk(p);
      } else if (e.name.endsWith('.ts')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/action:\s*'([a-z][a-z_.]+)'/g)) found.add(m[1]);
        for (const m of src.matchAll(/action:\s*\w+\s*\?\s*'([a-z][a-z_.]+)'\s*:\s*'([a-z][a-z_.]+)'/g)) {
          found.add(m[1]);
          found.add(m[2]);
        }
        for (const m of src.matchAll(/(?:AUDIT_\w+|\w*_ACTION|OPERATOR_VIEWED_PROJECT)\s*=\s*'([a-z][a-z_.]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk(SRC);
  return [...found].sort();
}

describe('[decisions-spoke-machine] решения человеку объясняются словами', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: у каждого действия из журнала есть подпись на языке человека', () => {
    const missing = actionsInCode().filter((a) => !(a in DECISION_LABELS));
    expect(missing).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: разбор действительно что-то находит, и реестр не шире кода', () => {
    // Пустой список выше означал бы не порядок, а сломанный разбор.
    const inCode = actionsInCode();
    expect(inCode.length).toBeGreaterThan(20);
    // Подпись, пережившая своё действие, — обещание про то, чего нет.
    // Один и тот же отбор для утверждения и для пробы механизма: иначе
    // мутация «пусть stale всегда пуст» проходит насквозь, а проба
    // рядом продолжает зеленеть, проверяя соседнее выражение. Тот же
    // урок, что в [server-said-which-day].
    const staleOf = (labels: string[]) => labels.filter((a) => !inCode.includes(a));
    expect(staleOf(Object.keys(DECISION_LABELS))).toEqual([]);
    expect(staleOf(['definitely.not.in.code'])).toEqual(['definitely.not.in.code']);
  });

  // Проверки самих подписей и поведения `describeDecision` файлов не
  // читают и живут в `…-decision-labels.spec.ts`: мера «проверок по
  // тексту исходника» считает файл целиком, а эти утверждения к тексту
  // исходника отношения не имеют.
});
