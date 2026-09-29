'use client';

// Пункт [job-domain-v2] — «Лист вакансии» команды (VACANCY): открывается из
// конфига и анкеты (пункты подтверждены сразу — их писал человек), принимает
// черновики из брифа и текста вакансии; подтверждённые пункты наследуются во
// все открытые листы кандидатов. Здесь же — черновик оффера из листа (А-1).
import { useEffect } from 'react';
import { sheetsApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { TermsSheetView, useOpenSheet } from './TermsSheetView';

export function VacancySheetPanel({ projectId }: { projectId: string }) {
  const { sheetId, setSheetId, error, busy, open } = useOpenSheet();
  useEffect(() => {
    sheetsApi.list(projectId).then((l) => { const v = l.find((s) => s.kind === 'VACANCY'); if (v) setSheetId(v.id); }).catch(() => undefined);
  }, [projectId, setSheetId]);
  if (sheetId) {
    return (
      <TermsSheetView
        sheetId={sheetId}
        role="team"
        intro={<p className="card-section__empty">Лист вакансии — требования и условия работодателя, каждое с источником (бриф, анкета, параметры). Подтверждённые пункты становятся столбцами матрицы и наследуются в листы кандидатов; черновики из брифа и текста ждут вашего подтверждения.</p>}
      />
    );
  }
  return (
    <section className="domain-panel">
      <AiErrorNotice error={error} />
      <p className="card-section__empty">Лист вакансии ещё не открыт. Он соберётся из параметров вакансии и анкеты — без AI.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => open(() => sheetsApi.openVacancy(projectId), () => sheetsApi.list(projectId).then((l) => l.filter((s) => s.kind === 'VACANCY')))}>{busy ? '…' : 'Открыть лист вакансии'}</button>
    </section>
  );
}
