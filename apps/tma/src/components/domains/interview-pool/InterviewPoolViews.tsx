'use client';

// Доменные вьюеры для трёх структур interview-pool, которые до этого
// рендерились generic JsonView: повестка собеседования, снимок
// релевантности пула, содержимое отчёта заказчику.
import { dateTime } from '../dtp/dtp-types';

interface Question { id: string; text: string; category?: string | null; isRequired: boolean }
interface CoverageRow { questionnaireItemId: string; coverage: 'covered' | 'partial' | 'not_covered'; note?: string }
interface RelevanceEntry { id: string; candidateProfileId: string; candidateProfile?: { displayName: string }; criteriaBreakdown: CoverageRow[] | null; attentionPoints: string[]; followUpRequestsDraft?: string[] }
interface Snapshot { id: string; createdAt: string; triggerConversationId: string | null; entries: RelevanceEntry[] }

const COV: Record<string, { icon: string; cls: string; label: string }> = {
  covered: { icon: '✓', cls: 'dtp-badge--ok', label: 'раскрыто' },
  partial: { icon: '◐', cls: 'dtp-badge--warn', label: 'частично' },
  not_covered: { icon: '✕', cls: 'dtp-badge--bad', label: 'не раскрыто' },
};

/** Повестка = вопросы, которые ещё НЕ раскрыты (backend фильтрует по
 * прошлым собеседованиям). Обязательные — сверху. */
export function AgendaView({ questions }: { questions: Question[] }) {
  if (!Array.isArray(questions)) return null;
  if (questions.length === 0) return <p className="dtp-status dtp-status--ok">Все вопросы опросника уже раскрыты в прошлых собеседованиях — повестка пуста.</p>;
  const required = questions.filter((q) => q.isRequired);
  return (
    <div style={{ width: '100%' }}>
      <p className="dtp-hint">{questions.length} вопрос(ов) к следующему собеседованию{required.length ? `, из них ${required.length} обязательных` : ''}. Раскрытые ранее — не показываются.</p>
      <ol className="dtp-criteria-group">
        {questions.map((q) => <li key={q.id}>{q.isRequired && <span className="dtp-badge dtp-badge--req">обязательно</span>} {q.text}{q.category && <span className="dtp-muted"> · {q.category}</span>}</li>)}
      </ol>
    </div>
  );
}

export function RelevanceSnapshotView({ snapshot, questions, compact }: { snapshot: Snapshot | null; questions: Question[]; compact?: boolean }) {
  if (!snapshot) return <p className="card-section__empty">Снимка ещё нет — нажмите «Пересчитать» после собеседований.</p>;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const score = (e: RelevanceEntry) => { const req = (e.criteriaBreakdown ?? []).filter((r) => byId.get(r.questionnaireItemId)?.isRequired); if (req.length === 0) return null; return req.filter((r) => r.coverage === 'covered').length / req.length; };
  return (
    <div style={{ width: '100%' }}>
      <p className="dtp-muted">Снимок от {dateTime(snapshot.createdAt)} · {snapshot.entries.length} кандидат(ов). Доля — обязательные вопросы, раскрытые полностью; это прозрачная метрика, не «балл» AI.</p>
      {snapshot.entries.map((e) => {
        const s = score(e);
        return (
          <div key={e.id} className="dtp-card" style={{ marginTop: 8 }}>
            <div className="dtp-card__head dtp-card__head--static">
              <strong>{e.candidateProfile?.displayName ?? e.candidateProfileId}</strong>
              {s !== null && <span className={`dtp-badge ${s >= 0.8 ? 'dtp-badge--ok' : s >= 0.5 ? 'dtp-badge--warn' : 'dtp-badge--bad'}`}>{Math.round(s * 100)}% обязательных</span>}
            </div>
            {!compact && (
              <div className="dtp-card__body">
                {e.criteriaBreakdown && <ul className="dtp-coverage">{e.criteriaBreakdown.map((r, i) => { const k = COV[r.coverage] ?? COV.not_covered; return <li key={i}><span className={`dtp-badge ${k.cls}`}>{k.icon}</span> {byId.get(r.questionnaireItemId)?.text ?? r.questionnaireItemId}{r.note && <span className="dtp-muted"> — {r.note}</span>}</li>; })}</ul>}
                {e.attentionPoints?.length > 0 && <><h4>На что обратить внимание</h4><ul className="dtp-criteria-group">{e.attentionPoints.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReportContentView({ content, questions }: { content: any; questions: Question[] }) {
  if (!content || typeof content !== 'object') return <pre className="dtp-protocol">{String(content ?? '')}</pre>;
  // SUMMARY
  if (content.funnel && Array.isArray(content.entries)) {
    const byStage: Record<string, number> = content.funnel.byStage ?? {};
    return (
      <div style={{ width: '100%' }}>
        <div className="dtp-facts">
          <div><span className="dtp-facts__label">Кандидатов</span><strong>{content.funnel.totalCandidates}</strong></div>
          {Object.entries(byStage).map(([stage, n]) => <div key={stage}><span className="dtp-facts__label">{stage}</span><strong>{n}</strong></div>)}
        </div>
        <table className="dtp-table" style={{ marginTop: 8 }}><thead><tr><th>Кандидат</th><th>Этап</th><th className="dtp-num">Покрытие</th></tr></thead>
          <tbody>{content.entries.map((e: any) => <tr key={e.candidateProfileId}><th>{e.displayName ?? e.candidateProfileId}</th><td>{e.stage ?? '—'}</td><td className="dtp-num">{typeof e.coverageScore === 'number' ? `${Math.round(e.coverageScore * 100)}%` : '—'}</td></tr>)}</tbody></table>
        <p className="dtp-hint">Порядок — по доле раскрытых обязательных вопросов, а не по скрытой оценке.</p>
      </div>
    );
  }
  // PER_CANDIDATE
  const byId = new Map(questions.map((q) => [q.id, q]));
  return (
    <div style={{ width: '100%' }}>
      {content.processDescription && <><h4>Как проходил отбор</h4><p style={{ whiteSpace: 'pre-wrap' }}>{content.processDescription}</p></>}
      {Array.isArray(content.criteriaBreakdown) && <><h4>По вопросам опросника</h4><ul className="dtp-coverage">{content.criteriaBreakdown.map((r: CoverageRow, i: number) => { const k = COV[r.coverage] ?? COV.not_covered; return <li key={i}><span className={`dtp-badge ${k.cls}`}>{k.icon}</span> {byId.get(r.questionnaireItemId)?.text ?? r.questionnaireItemId}{r.note && <span className="dtp-muted"> — {r.note}</span>}</li>; })}</ul></>}
      {content.conclusion && <><h4>Вывод (черновик AI — правится перед отправкой)</h4><pre className="dtp-protocol">{content.conclusion}</pre></>}
    </div>
  );
}
