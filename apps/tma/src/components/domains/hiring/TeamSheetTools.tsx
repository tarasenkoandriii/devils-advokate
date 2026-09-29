'use client';

// Пункт [job-domain-v2] — инструменты агентства/работодателя поверх листа
// кандидата (INTERVIEW): преданкета по ссылке (А-2), дебриф интервьюера (А-8),
// тестовое задание (А-5), обещание кандидату (А-7), письмо-статус (Р-10),
// сверка транскрипта собеседования с листом. Рамка везде одна: мнение
// интервьюера — отдельный вид опоры, не факт; письмо отправляет человек.
import { useState } from 'react';
import { Sheet, sheetsApi } from '../../../lib/hiring/api';
import { domainApi } from '../../../lib/domains/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { ShareLinkView } from '../InterviewPoolWorkspace';
import { haptic } from '../../../lib/telegram';
import { SkippedNote, DraftSkipsNotes, IntakeNotes, NotCheckedNote } from '../../SkippedNotes';

/** Сколько черновиков позиций создано. Форм ответа несколько (движок
 * отдаёт `{created, skipped}`, обёртки — `proposedPositions`), и «—»
 * ставится только когда числа действительно нет: ноль обязан выглядеть
 * как ноль, а не как «неизвестно». */
function positionCount(data: any): number | string {
  if (Array.isArray(data?.proposedPositions)) return data.proposedPositions.length;
  if (Array.isArray(data?.created)) return data.created.length;
  if (Array.isArray(data)) return data.length;
  if (typeof data?.proposedPositions === 'number') return data.proposedPositions;
  return '—';
}

export function TeamSheetTools({ sheet, refresh }: { sheet: Sheet; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<'none' | 'debrief' | 'test' | 'promise' | 'transcript'>('none');
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [letter, setLetter] = useState<{ text: string; frame: string } | null>(null);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); after?.(r); refresh(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="dtp-section">
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {link && <ShareLinkView link={link.link} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      <div className="entity-form__actions">
        {sheet.pipelineStatusId && <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.preQuestionnaire(sheet.pipelineStatusId!), (r) => setLink({ link: r.deepLink, expiresAt: r.expiresAt }))}>Ссылка на преданкету</button>}
        <button type="button" className="secondary" onClick={() => setMode('transcript')}>Сверить транскрипт собеседования</button>
        <button type="button" className="secondary" onClick={() => setMode('debrief')}>Дебриф интервьюера</button>
        <button type="button" className="secondary" onClick={() => setMode('test')}>Тестовое задание</button>
        <button type="button" className="secondary" onClick={() => setMode('promise')}>Обещание кандидату</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.statusLetter(sheet.id, 'waiting'), setLetter)}>Письмо «ждём решения»</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => sheetsApi.statusLetter(sheet.id, 'declined'), setLetter)}>Письмо «не продолжаем»</button>
      </div>
      <p className="dtp-hint">Преданкета — кандидат отвечает текстом по ссылке, видит уведомление об AI и даёт согласие на передачу ответов; его ответы становятся черновиками позиций, не баллами. Дебриф — мнение интервьюера, помеченное отдельно от фактов транскрипта; упоминания защищённых признаков уходят в compliance-флаги, а не в лист.</p>

      {mode === 'transcript' && (
        <EntityForm
          fields={[{ name: 'text', label: 'Транскрипт или его фрагмент', type: 'textarea', required: true, hint: 'AI предложит черновики позиций кандидата с цитатами из транскрипта' }]}
          submitLabel="Предложить позиции" onCancel={() => setMode('none')}
          onSubmit={async (v) => { setOut({ title: 'Позиции из транскрипта', data: await sheetsApi.propose(sheet.id, { evidenceKind: 'TRANSCRIPT_SEGMENT', text: String(v.text), bySide: 'CANDIDATE' }) }); setMode('none'); refresh(); }}
        />
      )}
      {mode === 'debrief' && (
        <EntityForm
          fields={[{ name: 'text', label: 'Что вы вынесли с собеседования — своими словами', type: 'textarea', required: true }]}
          submitLabel="Разобрать по пунктам" onCancel={() => setMode('none')}
          onSubmit={async (v) => { setOut({ title: 'Дебриф: мнение интервьюера по пунктам', data: await sheetsApi.debrief(sheet.id, String(v.text)) }); setMode('none'); refresh(); }}
        />
      )}
      {mode === 'test' && (
        <EntityForm
          fields={[{ name: 'assignmentText', label: 'Текст задания', type: 'textarea', required: true }, { name: 'answerText', label: 'Ответ кандидата', type: 'textarea', required: true }]}
          submitLabel="Сверить по пунктам" onCancel={() => setMode('none')}
          onSubmit={async (v) => { setOut({ title: 'Тестовое задание: отражено / не отражено', data: await sheetsApi.testAssignment(sheet.id, v as any) }); setMode('none'); refresh(); }}
        />
      )}
      {mode === 'promise' && (
        <EntityForm
          fields={[{ name: 'description', label: 'Что обещали кандидату', type: 'text', required: true }, { name: 'dueDate', label: 'К какому сроку', type: 'date' }]}
          submitLabel="Записать обещание" onCancel={() => setMode('none')}
          onSubmit={async (v) => { await sheetsApi.promise(sheet.id, v as any); setMode('none'); haptic('success'); }}
        />
      )}
      {letter && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>Письмо кандидату — черновик, отправляете вы</span><button type="button" className="dtp-link" onClick={() => setLetter(null)}>скрыть</button></div>
          <div className="dtp-card__body">
            <p className="dtp-status dtp-status--warn">{letter.frame}</p>
            <pre className="script-text">{letter.text}</pre>
            {/* Пункт [log-says-we-saw-it] 2026-09-24: продукт письма не
                отправляет — это делает человек своей почтой. Кнопка
                говорила «Отметить: отправлено», а запись в журнале
                утверждала отправку. Теперь кнопка называет, чьё это
                утверждение, и рядом сказано, что продукт его не
                проверяет: отметка попадает в чеклист закрытия вакансии
                как «ответ отмечен», и человек вправе знать, на чём
                чеклист стоит. */}
            <button type="button" className="primary" disabled={busy} onClick={() => run(() => sheetsApi.statusLetterSent(sheet.id, true), () => setLetter(null))}>Я отправил(а) это письмо — отметить</button>
            <p className="dtp-muted">Продукт письма не отправляет и отправку не проверяет: отметка записывается с ваших слов.</p>
          </div>
        </div>
      )}
      {out && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div>
          <div className="dtp-card__body">
            {out.data?.frame && <p className="dtp-status dtp-status--warn">{out.data.frame}</p>}
            {/* [dropped-quotes] 2026-09-04: строка «compliance-флагов: N»
                ниже при нуле не печатается вовсе, а речь о защищённых
                признаках в дебрифе — там молчание дороже всего. */}
            {/* Пункт [not-checked-looks-clean] 2026-09-06: строка
                «compliance-флагов: N» ниже при нуле молчит, и до сих пор
                это было молчание О ДВУХ РАЗНЫХ СОБЫТИЯХ — «спорного не
                нашли» и «не смотрели». Второе теперь названо, и раньше
                всех прочих подписей: остальные уточняют результат, эта
                говорит, что результата нет. */}
            <NotCheckedNote reason={out.data?.complianceNotChecked} what="дебриф на защищённые признаки" />
            <SkippedNote skipped={out.data?.skippedWithoutQuote} />
            {/* [draft-outcome] 2026-09-04: «Черновиков позиций: 3» и
                «требование — unknown» человек читает как факт о тексте
                («столько там и было») или о кандидате («в ответе не
                отражено»). Разобранное мимо теперь названо — и по
                причинам, потому что «модель придумала пункт» и «текст не
                поместился, разбейте на части» требуют разного. */}
            {/* Пункт [input-truncated] 2026-09-05: `complianceIntake`
                отдельно от общего — под пустым списком флагов экран
                пишет утвердительно «Compliance-флагов нет», и это
                утверждение обо ВСЁМ дебрифе. */}
            <IntakeNotes intake={out.data?.intake ?? out.data?.complianceIntake} storedIntake={out.data?.storedIntake} what="текст" />
            <DraftSkipsNotes skips={out.data?.draftSkips ?? out.data?.skipped} />
            {out.data?.marker &&<p className="dtp-muted">Помечено как: {out.data.marker}{out.data.complianceFlags ? ` · compliance-флагов: ${out.data.complianceFlags}` : ''}</p>}
            {Array.isArray(out.data?.requirements) ? (
              <ul>{out.data.requirements.map((r: any) => <li key={r.clauseId}><strong>{r.text}</strong> — {r.coverage}{r.quote ? <span className="dtp-muted"> · «{r.quote}»</span> : null}</li>)}</ul>
            ) : (
              <p className="dtp-muted">Черновиков позиций: {positionCount(out.data)} — подтвердите их на вкладке «Пункты».</p>
            )}
            {!Array.isArray(out.data?.requirements) && !Array.isArray(out.data?.proposedPositions) && !Array.isArray(out.data?.created) && !Array.isArray(out.data) && <JsonView data={out.data} />}
          </div>
        </div>
      )}
      <p className="dtp-muted">Транскрипт записанного собеседования уже сверяется с листом автоматически при разборе (релевантность); здесь — ручной ввод фрагмента. Разговоры проекта: <button type="button" className="dtp-link" onClick={() => domainApi.getJson(`/projects/${sheet.projectId}/conversations`).then((d) => setOut({ title: 'Разговоры проекта', data: d })).catch(setError)}>показать</button>.</p>
    </div>
  );
}
