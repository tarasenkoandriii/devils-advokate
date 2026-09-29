'use client';

// Пункт [render-guards] 2026-09-04 — одна разметка на все подписи о
// потерянном, и её наконец можно ПРОВЕРИТЬ.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Подписи «часть находок отброшена» и «часть
// черновиков не сохранена» ([dropped-quotes], [draft-outcome]) были
// вписаны по месту в шесть экранов — шесть одинаковых `<p>` с
// `role="status"`. Пока разметка живёт внутри больших панелей с хуками и
// запросами, проверить её можно только чтением исходника регуляркой, а
// такая проверка подтверждает НАЛИЧИЕ СЛОВА, не поведение: мутация
// «обернуть весь блок в `{false && …}`» проходила её насквозь — подпись
// в файле есть, на экране её нет никогда.
//
// Вынесено сюда не ради красоты, а чтобы проверка стала возможной: этот
// компонент рисуется тестом целиком, и тест смотрит на РАЗМЕТКУ —
// произносится ли текст, внутри ли он живой области, появляется ли он
// вообще. Заодно исчезло шесть копий одного и того же тега, которые
// умели разъехаться.

import { skippedWithoutQuoteNote, draftSkipsNotes, intakeNote, storedIntakeNote, notCheckedNote, paralinguisticsNotes } from '../lib/skipped-note';

/** Одна подпись в живой области.
 *
 * `role="status"`, а не `alert`: это уточнение к уже показанному
 * результату, перебивать им чтение нечего (та же граница, что у
 * `SectionLoadError`). Текст ВНУТРИ элемента с ролью, а не рядом с ним:
 * пустая живая область объявляет ровно ничего — мутация, которую
 * прежняя проверка не ловила. */
function Note({ text }: { text: string }) {
  return (
    <p className="dtp-status dtp-status--warn" role="status">
      {text}
    </p>
  );
}

/** Сколько находок модели отброшено за отсутствие опоры в исходном
 * тексте. Ноль не печатается вовсе — строка «отброшено: 0» приучает её
 * не читать. */
export function SkippedNote({ skipped }: { skipped: unknown }) {
  const text = skippedWithoutQuoteNote(skipped);
  if (!text) return null;
  return <Note text={text} />;
}

/** Что не сохранено при разборе черновиков — по причинам, а не одним
 * числом, и по потокам, если их несколько. */
export function DraftSkipsNotes({ skips }: { skips: unknown }) {
  const notes = draftSkipsNotes(skips);
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((note) => (
        <Note key={note} text={note} />
      ))}
    </>
  );
}

/** Пункт [input-truncated] 2026-09-05 — сколько текста источника вообще
 * дошло до разбора. Два разных события, и порядок не случаен: сначала
 * «не сохранилось» (необратимо), потом «не разобрано» (повторимо). */
export function IntakeNotes({ intake, storedIntake, what }: { intake?: unknown; storedIntake?: unknown; what?: string }) {
  const stored = storedIntakeNote(storedIntake, what);
  const parsed = intakeNote(intake, what);
  if (!stored && !parsed) return null;
  return (
    <>
      {stored && <Note text={stored} />}
      {parsed && <Note text={parsed} />}
    </>
  );
}

/** Пункт [not-checked-looks-clean] 2026-09-06 — проверки не было вовсе.
 *
 * Роль `alert`, а не `status`, в отличие от всех подписей выше, и это
 * решение по смыслу: остальные уточняют показанный результат, а эта
 * говорит, что показанного результата НЕТ — ноль под ней ничего не
 * значит. Такое человек обязан услышать, даже если читает бегло. */
export function NotCheckedNote({ reason, what }: { reason: unknown; what: string }) {
  const text = notCheckedNote(reason, what);
  if (!text) return null;
  return (
    <p className="dtp-status dtp-status--warn" role="alert">
      {text}
    </p>
  );
}

/** Пункт [job-died-quietly] 2026-09-06 — исход фоновой задачи разбора
 * подачи. Провал — `alert`, как и всякое «результата нет»; отброшенные
 * находки — `status`, как все прочие уточнения к результату. */
export function ParalinguisticsNotes({ enabled, error, skipped }: { enabled: unknown; error: unknown; skipped: unknown }) {
  const notes = paralinguisticsNotes(enabled, error, skipped);
  if (notes.length === 0) return null;
  const failed = typeof error === 'string' && error.trim().length > 0;
  return (
    <>
      {notes.map((note, i) => (
        <p
          key={note}
          className="dtp-status dtp-status--warn"
          role={failed && i === 0 ? 'alert' : 'status'}
        >
          {note}
        </p>
      ))}
    </>
  );
}
