'use client';

// Пункт [job-domain-v2] — кнопка «Лист кандидата» в карточке кандидата
// (агентство и работодатель). Открывает INTERVIEW-лист по pipelineStatus: если
// уже открыт — бэкенд отвечает 409 с existingSheetId, экран просто показывает
// его. Инструменты команды (преданкета, дебриф, письмо-статус) — внутри листа.
import { Sheet, sheetsApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { TermsSheetView, useOpenSheet } from './TermsSheetView';
import { TeamSheetTools } from './TeamSheetTools';

export function CandidateSheetLauncher({ pipelineStatusId }: { pipelineStatusId: string }) {
  const { sheetId, setSheetId, error, busy, open } = useOpenSheet();
  if (sheetId) {
    return (
      <div className="dtp-section">
        <button type="button" className="secondary" onClick={() => setSheetId(null)}>Свернуть лист кандидата</button>
        <TermsSheetView sheetId={sheetId} role="team" extras={(sheet: Sheet, refresh) => <TeamSheetTools sheet={sheet} refresh={refresh} />} />
      </div>
    );
  }
  return (
    <div>
      <AiErrorNotice error={error} />
      <button type="button" className="secondary" disabled={busy} onClick={() => open(() => sheetsApi.openForCandidate(pipelineStatusId))}>{busy ? '…' : 'Лист кандидата'}</button>
    </div>
  );
}
