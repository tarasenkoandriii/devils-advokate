// Сверка 2026-09-24 — цвет делал вердикт о человеке.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [lag-told-only-the-log] смотрел, что
// доходит до человека о СОСТОЯНИИ продукта. Здесь — что доходит о
// ДРУГОМ ЧЕЛОВЕКЕ, и не словами, а оформлением.
//
// НАЙДЕННОЕ. В снимке релевантности у каждого кандидата стоял бейдж с
// долей раскрытых обязательных вопросов, покрашенный по порогам:
// ≥ 0.8 — зелёный, ≥ 0.5 — жёлтый, ниже — красный.
//
// Само число честно и прозрачно: сколько обязательных вопросов анкеты
// раскрыто полностью. Вердикт делал ЦВЕТ. Зелёный кандидат и красный
// кандидат — это ровно рейтинг людей, которого продукт обещает не
// делать, и на ТОМ ЖЕ ЭКРАНЕ подпись говорила: «это прозрачная метрика,
// не „балл" AI».
//
// ДВА ОТЯГЧАЮЩИХ.
//
// 1. Пороги 0.8 и 0.5 не взяты ниоткуда. Ни ТЗ, ни код их не
//    обосновывают — это привычка светофора. Тот же класс, что разбирал
//    пункт [uncalibrated-number]: число, которому приписана шкала.
//
// 2. Доля — свойство РАЗГОВОРА не меньше, чем человека. О чём-то могли
//    не успеть спросить, встреча могла оборваться. «Кандидат не
//    ответил» и «мы не спросили» по самому числу неразличимы, а красный
//    цвет приписывал человеку то, что могло быть свойством процесса.
//
// СДЕЛАНО. Цвет убран, число осталось и названо полностью; подпись
// теперь говорит не только чем число НЕ является, но и чьё оно
// свойство.
//
// ВТОРОЕ МЕСТО, И ОНО РЕШЕНО ИНАЧЕ. Отметка «скрылся с места» у
// участника ДТП — красная, и цвет здесь ОСТАВЛЕН: он отмечает
// юридически значимое обстоятельство, от которого зависят сроки и
// порядок действий, а не качество человека. Но ставит её сам
// пользователь при добавлении участника, а выглядела она как
// установленный факт. Теперь сказано, с чьих слов, — тем же приёмом,
// что и в [log-says-we-saw-it].
//
// ПРАВИЛО НИЖЕ — ПО ФОРМЕ, А НЕ ПО СПИСКУ: «хороший/плохой» цвет рядом с
// именем человека. Список файлов устарел бы молча, а новый экран с
// карточкой кандидата заведётся не там, где его ждут.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

/** Исходник без комментариев: объяснения самой сверки и цитаты «как было
 * раньше» не должны считаться нарушением. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Оценочный цвет: зелёный «хорошо» и красный «плохо». Жёлтый сам по
 * себе предупреждение, а не оценка, и в паре с ними не нужен. */
const VERDICT_COLOUR = /dtp-badge--(ok|bad)/;

/** Признаки того, что рядом — ЧЕЛОВЕК, а не пункт, критерий или
 * документ. Только имена людей: `coverage` у вопроса красить можно и
 * нужно, это свойство вопроса. */
const NEAR_PERSON = /candidateProfile|\bdisplayName\b|p\.role|participant/;

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: оценочный цвет не стоит рядом с именем человека', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const lines = code(file).split('\n');
      lines.forEach((line, i) => {
        if (!VERDICT_COLOUR.test(line)) return;
        const around = lines.slice(Math.max(0, i - 5), i + 3).join('\n');
        if (!NEAR_PERSON.test(around)) return;
        // Обстоятельство, названное со слов, — не оценка человека:
        // цвет там отмечает юридически значимый факт, и это решение
        // записано в самом экране.
        if (/с ваших слов|со слов/.test(around)) return;
        offenders.push(`${file.replace(SRC, '')}:${i + 1}`);
      });
    }
    assert(offenders.length === 0, `оценочный цвет у человека: ${offenders.join('; ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: правило действительно срабатывает', () => {
    // Обратная проба: за эту сессию семь раз выяснялось, что правило
    // сторожит ровно то, что уже исправлено.
    const probe = [
      '<strong>{e.candidateProfile?.displayName}</strong>',
      '<span className={`dtp-badge ${s >= 0.8 ? "dtp-badge--ok" : "dtp-badge--bad"}`}>{pct}%</span>',
    ];
    const caught = probe.some((line, i) => VERDICT_COLOUR.test(line) && NEAR_PERSON.test(probe.slice(0, i + 1).join('\n')));
    assert(caught, 'правило не ловит заведомое нарушение — оно ничего не сторожит');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: доля по кандидату показана, но без шкалы «хорошо/плохо»', () => {
    const src = code(join(SRC, 'components/domains/interview-pool/InterviewPoolViews.tsx'));
    // Число осталось — убирать его было бы другой крайностью: рекрутер
    // вправе видеть, сколько из анкеты раскрыто.
    assert(/обязательных вопросов раскрыто/.test(src), 'число доли исчезло с экрана');
    // Пороги ушли вместе с цветом: они и были шкалой.
    assert(!/0\.8/.test(src) && !/>= 0\.5/.test(src), 'пороги светофора всё ещё в коде');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись говорит, ЧЬЁ это свойство, а не только чем оно не является', () => {
    const src = readFileSync(join(SRC, 'components/domains/interview-pool/InterviewPoolViews.tsx'), 'utf8');
    assert(/свойство разговора/i.test(src), 'не сказано, что доля — свойство разговора, а не только человека');
    assert(/не «балл»/i.test(src), 'утрачено прежнее честное уточнение');
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\ncolour-made-a-verdict: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
