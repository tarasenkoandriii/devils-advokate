// Пункт [job-domain-v2] §8.5 — три аудитории на /jobs и честные границы.
//
// Типы гарантируют, что поле есть во всех трёх языках, но не гарантируют
// СОДЕРЖАНИЕ. А содержание здесь — обещание продукта: страница не должна
// обещать работодателю отбор кандидатов, ранжирование или «AI-балл»
// (§8.5: честная граница «не отбирает за вас»). Один забытый глагол в
// переводе — и лендинг обещает то, чего продукт не делает и делать не
// будет. Эти проверки дешевле, чем разбирательство потом.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Первой версией была проверка «в тексте не
// встречаются слова „ранжирует кандидатов“ / „рейтинг людей“ / „балл
// кандидата“». Она падала на честных фразах самого продукта: «Жодного
// прихованого рейтингу людей», «neither ranks candidates nor rejects
// anyone automatically» — это ОТРИЦАНИЯ, то есть ровно тот голос, ради
// которого проверка и задумывалась. Отличать отрицание от обещания
// регулярками в трёх языках — способ получить ложную уверенность и
// переписывать честный текст в угоду тесту. Проверка убрана осознанно;
// границы формулировок держит ревью текста, а не подстрока.

import { locales } from '../lib/i18n/config';
import { getJobsDictionary } from '../lib/i18n/jobs';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const scenarios: Array<[string, () => void]> = [
  ['во всех языках есть третья аудитория с четырьмя пунктами и CTA', () => {
    for (const lang of locales) {
      const d = getJobsDictionary(lang);
      assert(d.hero.tabEmployers.trim().length > 0, `${lang}: пустая вкладка работодателя`);
      assert(d.employers.title.trim().length > 0, `${lang}: пустой заголовок секции работодателя`);
      assert(d.employers.cta.trim().length > 0, `${lang}: пустой CTA работодателя`);
      assert(d.employers.points.length === 4, `${lang}: у работодателя ${d.employers.points.length} пунктов, ожидалось 4`);
      assert(d.finalCta.employers.trim().length > 0, `${lang}: пустая кнопка работодателя в финальном CTA`);
      for (const p of d.employers.points) {
        assert(p.title.trim().length > 0 && p.description.trim().length > 0, `${lang}: пустой пункт у работодателя`);
      }
    }
  }],
  ['вкладки трёх аудиторий различаются между собой', () => {
    for (const lang of locales) {
      const d = getJobsDictionary(lang);
      const tabs = [d.hero.tabCandidates, d.hero.tabAgencies, d.hero.tabEmployers];
      assert(new Set(tabs).size === 3, `${lang}: вкладки аудиторий повторяются: ${tabs.join(' / ')}`);
      const cta = [d.finalCta.candidates, d.finalCta.agencies, d.finalCta.employers];
      assert(new Set(cta).size === 3, `${lang}: кнопки финального CTA повторяются: ${cta.join(' / ')}`);
    }
  }],
  ['граница «не отбирает за вас» есть во всех языках пятым пунктом', () => {
    for (const lang of locales) {
      const d = getJobsDictionary(lang);
      assert(d.boundaries.items.length === 5, `${lang}: границ ${d.boundaries.items.length}, ожидалось 5`);
      const last = d.boundaries.items[4];
      assert(/отбира|відбира|select/i.test(last.title), `${lang}: пятая граница не про отбор: «${last.title}»`);
      assert(/итог|підсумок|total/i.test(last.description), `${lang}: в границе не сказано про отсутствие столбца «итог»`);
    }
  }],
  ['у работодателя в FAQ есть свой вопрос', () => {
    // §8.5: третья аудитория приходит с вопросом «я нанимаю сам — что мне
    // это даёт»; без ответа страница отвечает только двум первым.
    for (const lang of locales) {
      const d = getJobsDictionary(lang);
      const hit = d.faq.items.some((i) => /без агент|without an agency|без агенц/i.test(i.q));
      assert(hit, `${lang}: в FAQ нет вопроса от работодателя, нанимающего сам`);
    }
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
console.log(`\njobs.ts (словарь /jobs): ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
