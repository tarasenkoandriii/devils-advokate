'use client';

// Доменная вёрстка «Подбор персонала» — обзор вакансии и флаги
// соответствия (остальные вкладки — ручные панели InterviewPoolWorkspace,
// сделанные в фазе C). Флаги соответствия — формулировки из описания
// вакансии, которые могут быть дискриминационными; они не запрещают
// ничего, но показываются до публикации, с цитатой.
import { useList } from '../shared/ConsultationPipeline';

interface Stage { id: string; name: string; orderIndex: number; isTestAssignment: boolean; interviewerRole: string | null }
interface IpConfig { id: string; jobTitle: string; extendedDescription: string; salaryRange: string | null; employmentLoad: string | null; workArrangement: string | null; officeLocation: string | null; employmentFormat: string | null; perks: string[]; genderRequirement: string; ageRequirement: string; minAge: number | null; maxAge: number | null; isPhysicallyDemanding: boolean; interviewStages: Stage[]; questions?: Array<{ id: string; text: string; isRequired: boolean }> }
interface ComplianceFlag { id: string; category: string; quotedText: string; createdAt: string }

const LOAD: Record<string, string> = { FULL_TIME: 'полная занятость', PART_TIME: 'частичная' };
const ARR: Record<string, string> = { OFFICE: 'офис', REMOTE: 'удалённо', HYBRID: 'гибрид' };
const GENDER: Record<string, string> = { NOT_IMPORTANT: 'не важен', MALE: 'мужчины', FEMALE: 'женщины', OTHER: 'иное' };

export function InterviewPoolOverview({ config, projectId }: { config: IpConfig; projectId: string }) {
  const { data: flags } = useList<ComplianceFlag>(`/interview-pool/projects/${projectId}/compliance-flags`);
  const restrictive = config.genderRequirement !== 'NOT_IMPORTANT' || config.ageRequirement === 'RANGE';
  return (
    <section className="dtp-overview">
      <div className="dtp-facts">
        <div><span className="dtp-facts__label">Зарплата</span><strong>{config.salaryRange ?? '—'}</strong></div>
        <div><span className="dtp-facts__label">Занятость</span><strong>{LOAD[config.employmentLoad ?? ''] ?? config.employmentLoad ?? '—'}</strong></div>
        <div><span className="dtp-facts__label">Формат</span><strong>{ARR[config.workArrangement ?? ''] ?? config.workArrangement ?? '—'}{config.officeLocation && ` · ${config.officeLocation}`}</strong></div>
        <div><span className="dtp-facts__label">Оформление</span><strong>{config.employmentFormat ?? '—'}</strong></div>
        <div><span className="dtp-facts__label">Вопросов в опроснике</span><strong>{config.questions?.length ?? 0}</strong></div>
      </div>
      <h2 style={{ margin: '4px 0' }}>{config.jobTitle}</h2>
      <p className="dtp-goal" style={{ whiteSpace: 'pre-wrap' }}>{config.extendedDescription}</p>
      {config.perks?.length > 0 && <p className="dtp-muted">Плюсы: {config.perks.join(', ')}</p>}

      {(restrictive || config.isPhysicallyDemanding) && (
        <div className="dtp-card" style={{ width: '100%' }}>
          <div className="dtp-card__body">
            {config.genderRequirement !== 'NOT_IMPORTANT' && <p className="dtp-warn">Требование по полу: {GENDER[config.genderRequirement] ?? config.genderRequirement}. Законно только при доказуемой связи с работой — проверьте формулировку.</p>}
            {config.ageRequirement === 'RANGE' && <p className="dtp-warn">Возраст: {config.minAge ?? '…'}–{config.maxAge ?? '…'}. Возрастные ограничения в вакансии — частый повод для жалобы; убедитесь, что они обоснованы.</p>}
            {config.isPhysicallyDemanding && <p className="dtp-muted">Физически тяжёлая работа — отмечено; допустимо указывать как условие.</p>}
          </div>
        </div>
      )}

      <h3>Флаги соответствия</h3>
      {flags && flags.length === 0 && <p className="dtp-status dtp-status--ok">В описании вакансии спорных формулировок не найдено.</p>}
      {flags && flags.length > 0 && <p className="dtp-status dtp-status--warn">{flags.length} формулировк{flags.length === 1 ? 'а' : flags.length < 5 ? 'и' : ''} стоит пересмотреть до публикации — приложение не запрещает, только показывает.</p>}
      {flags?.map((f) => (
        <div key={f.id} className="dtp-card" style={{ width: '100%' }}><div className="dtp-card__body">
          <span className="dtp-badge dtp-badge--warn">{f.category}</span>
          <blockquote style={{ margin: '4px 0', fontStyle: 'italic' }}>«{f.quotedText}»</blockquote>
        </div></div>
      ))}

      <h3>Этапы собеседования</h3>
      {config.interviewStages.length === 0 && <p className="card-section__empty">Этапы не заданы.</p>}
      <ol className="dtp-timeline">
        {config.interviewStages.map((s) => <li key={s.id} className="dtp-timeline__item"><time>{s.orderIndex + 1}</time><div><strong>{s.name}</strong>{s.isTestAssignment && <span className="dtp-badge dtp-badge--warn" style={{ marginLeft: 6 }}>тестовое</span>}{s.interviewerRole && <><br /><span className="dtp-muted">{s.interviewerRole}</span></>}</div></li>)}
      </ol>
      <p className="dtp-hint">Дальше: «Опросник» (черновик от AI → правка), затем «Кандидаты» — этапы, повестка, follow-up. Отчёт заказчику — только после вашей проверки.</p>
    </section>
  );
}
