'use client';

// Пункт [job-domain-v2] связка П — инструменты соискателя над всеми
// вакансиями: запросы под площадки (К-11), пакетная сверка (К-12), матрица
// «вакансии × критерии» с фильтром и ОТКЛЮЧАЕМОЙ сортировкой (К-13),
// критерии из своих слов (К-15), карта пробелов «не рынок» (К-16).
import { useEffect, useState } from 'react';
import { intakeApi, sheetsApi, COVERAGE_LABEL } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { JsonView } from '../JsonPanel';
import { haptic } from '../../../lib/telegram';
import { SkippedNote } from '../../SkippedNotes';

const FILTERS: Array<[string, string]> = [['all', 'все'], ['required_covered', 'обязательные отражены'], ['has_unknown', 'есть «не сказано»'], ['has_not_covered', 'есть «нет в вакансии»']];

/** Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — вердикт о
 * расхождениях отдельным компонентом, чтобы его можно было НАРИСОВАТЬ в
 * проверке. Раньше здесь стояло «расхождений не найдено» — и стояло
 * ДАЖЕ когда находки были, но все до одной отброшены проверкой цитат
 * (`droppedUnverifiable`): человек читал «не найдено» там, где на самом
 * деле «ни одно не подтвердилось». Это ровно та подмена, которую продукт
 * себе запрещает. */
export function ConsistencyVerdict({ consistency }: { consistency: { discrepancies?: unknown[]; variantsCompared?: number; droppedUnverifiable?: number } | null }) {
  if (!consistency) return null;
  const compared = consistency.variantsCompared ?? 0;
  const found = consistency.discrepancies?.length ?? 0;
  const dropped = consistency.droppedUnverifiable ?? 0;
  if (compared < 2) return null;
  if (found === 0) {
    return dropped > 0 ? (
      <p className="dtp-status dtp-status--warn" role="status">
        Подтверждённых расхождений между {compared} вариантами нет. Но {dropped} находк(и) отброшено: названного в них
        текста нет ни в одном из вариантов — проверить их нечем, поэтому продукт их не показывает. Это не то же самое,
        что «расхождений нет».
      </p>
    ) : (
      <p className="dtp-status dtp-status--ok">Расхождений между {compared} вариантами не найдено.</p>
    );
  }
  return dropped > 0 ? (
    <p className="dtp-hint">
      Ещё {dropped} находк(и) отброшено: названного в них текста нет ни в одном из вариантов.
    </p>
  ) : null;
}

export function JobSearchToolsPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [sub, setSub] = useState<'matrix' | 'queries' | 'criteria' | 'gaps' | 'consistency'>('matrix');
  const [consistency, setConsistency] = useState<any | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [matrix, setMatrix] = useState<any | null>(null);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [queries, setQueries] = useState<any | null>(null);
  const [suggestions, setSuggestions] = useState<any | null>(null);
  const [gaps, setGaps] = useState<any | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setError(null);
    if (sub === 'matrix') intakeApi.matrix(projectId, { filter, sort: sort ? 'true' : undefined }).then(setMatrix).catch(setError);
    if (sub === 'queries' && !queries) intakeApi.queryBuilder(projectId).then(setQueries).catch(setError);
    if (sub === 'criteria' && !suggestions) intakeApi.criteriaSuggestions(projectId).then(setSuggestions).catch(setError);
    if (sub === 'gaps') intakeApi.gapMap(projectId).then(setGaps).catch(setError);
    // К-23 (аудит 2026-09-03): расхождения между вариантами CV — раньше
    // сервис был написан, но маршрута и экрана к нему не было.
    if (sub === 'consistency') sheetsApi.cvConsistency(projectId).then(setConsistency).catch(setError);
  }, [sub, filter, sort, projectId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); after?.(r); setTick((t) => t + 1); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const rows: any[] = matrix?.rows ?? [];
  const cols: any[] = matrix?.criteria ?? [];

  return (
    <section className="domain-panel">
      <nav className="domain-tabs">
        {([['matrix', 'Матрица'], ['queries', 'Запросы под площадки'], ['criteria', 'Критерии из моих слов'], ['gaps', 'Карта пробелов'], ['consistency', 'Сверка моих CV']] as Array<[typeof sub, string]>).map(([k, l]) => (
          <button key={k} type="button" className={sub === k ? 'domain-tabs__tab domain-tabs__tab--active' : 'domain-tabs__tab'} onClick={() => setSub(k)}>{l}</button>
        ))}
      </nav>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />

      {sub === 'matrix' && (
        <>
          <p className="dtp-hint">Матрица показывает, что из ваших критериев в каждой вакансии названо. Сортировка по числу отражённых критериев выключена по умолчанию и не означает «лучше» — это только порядок строк.</p>
          <div className="entity-form__actions">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>{FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label><input type="checkbox" checked={sort} onChange={(e) => setSort(e.target.checked)} /> сортировать по числу отражённых</label>
            <button type="button" className="primary" disabled={busy || !Object.values(selected).some(Boolean)} onClick={() => run(() => intakeApi.batchMatch(projectId, Object.keys(selected).filter((k) => selected[k])), () => setSelected({}))}>Сверить отмеченные фоном</button>
          </div>
          {!matrix && <p className="dtp-muted">Загрузка…</p>}
          {matrix && rows.length === 0 && <p className="card-section__empty">Вакансий под фильтр нет.</p>}
          {rows.length > 0 && (
            <div className="domain-table-wrap">
              <table className="domain-table dtp-table dtp-table--matrix">
                <thead><tr><th></th><th>Вакансия</th>{cols.map((c: any) => <th key={c.id}>{c.text}{c.isRequired ? ' *' : ''}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r: any) => (
                    <tr key={r.vacancyId}>
                      <td><input type="checkbox" checked={!!selected[r.vacancyId]} onChange={(e) => setSelected({ ...selected, [r.vacancyId]: e.target.checked })} /></td>
                      <td>{r.favorite ? '★ ' : ''}{r.title ?? r.siteHost ?? r.vacancyId}{r.matched ? '' : <span className="dtp-muted"> · без сверки</span>}{r.queued ? <span className="dtp-muted"> · в очереди</span> : null}</td>
                      {cols.map((c: any) => { const cov = r.byCriterion?.[c.id]?.coverage; return <td key={c.id}>{cov ? COVERAGE_LABEL[cov] ?? cov : '—'}</td>; })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {sub === 'queries' && (
        <>
          <p className="dtp-hint">Поисковые запросы под площадки — из вашей роли, города и критериев. Приложение не ищет само и не «мониторит рынок»: скопируйте запрос и откройте площадку.</p>
          {!queries && <p className="dtp-muted">Загрузка…</p>}
          {queries && <JsonView data={queries} />}
        </>
      )}

      {sub === 'criteria' && (
        <>
          <p className="dtp-hint">Критерии, которые AI услышал в вашем рассказе, но которых пока нет в списке — с цитатой. Добавляется только то, что вы подтвердите.</p>
          {!suggestions && <p className="dtp-muted">Загрузка…</p>}
          {suggestions && (Array.isArray(suggestions) ? suggestions : suggestions.suggestions ?? []).length === 0 && <p className="card-section__empty">Новых критериев в ваших словах не нашлось.</p>}
          {/* [dropped-quotes] 2026-09-04: «не нашлось» и «нашлось, но без
              опоры на ваши слова» — разные вещи, и второе молчало. */}
          <SkippedNote skipped={suggestions?.skippedWithoutQuote} />
          <ul>
            {(Array.isArray(suggestions) ? suggestions : suggestions?.suggestions ?? []).map((s: any, i: number) => (
              <li key={`${s.text}-${i}`}>
                <strong>{s.text}</strong> <span className="dtp-muted">· {s.category}{s.quote ? ` · «${s.quote}»` : ''}</span>
                {' '}
                <button type="button" className="dtp-link" disabled={busy} onClick={() => run(() => intakeApi.addCriterion(projectId, { text: s.text, category: s.category, isRequired: !!s.isRequired }), () => setSuggestions(null))}>добавить</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {sub === 'consistency' && (
        <>
          <p className="dtp-hint">Если под разные вакансии вы собрали разные варианты резюме, здесь видно, где они расходятся между собой — двумя цитатами, без вывода «где правда». Разные акценты — это нормально; несовпадение фактов лучше заметить до того, как его заметит работодатель.</p>
          {!consistency && <p className="dtp-muted">Загрузка…</p>}
          {consistency && consistency.variantsCompared < 2 && <p className="card-section__empty">Пока меньше двух собранных вариантов — сравнивать не с чем.</p>}
          <ConsistencyVerdict consistency={consistency} />
          <ul>
            {(consistency?.discrepancies ?? []).map((d: any, i: number) => (
              <li key={i}>
                <strong>{d.topic}</strong>: «{d.a?.quote}» ↔ «{d.b?.quote}»
              </li>
            ))}
          </ul>
        </>
      )}

      {sub === 'gaps' && (
        <>
          {gaps?.frame && <p className="dtp-status dtp-status--warn">{gaps.frame}</p>}
          <p className="dtp-hint">Какие пункты вакансий чаще всего не отражены в вашем резюме — по вашим же вакансиям, не по «рынку». Это повод уточнить резюме или критерии, не оценка вас.</p>
          {!gaps && <p className="dtp-muted">Загрузка…</p>}
          {gaps && <JsonView data={Object.fromEntries(Object.entries(gaps).filter(([k]) => k !== 'frame'))} />}
        </>
      )}
    </section>
  );
}
