'use client';

// Пункт [job-domain-v2] Р-4 — агентство принимает приглашение работодателя
// (start_param `eng_<token>`): выбирает свою команду агентства, и бэкенд создаёт
// проект-пул с копией ровно тех материалов, что работодатель отметил. Внутри
// Mini App — нужна авторизация участника команды.
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { domainApi } from '../../../lib/domains/api';
import { employerApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../../../components/domains/AiErrorNotice';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function EngagementAcceptPage() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [teams, setTeams] = useState<any[] | null>(null);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<any | null>(null);
  useBackButton(() => router.push('/domains/interview-pool'));
  useEffect(() => { domainApi.getJson('/recruiting-teams').then((t) => { setTeams(t); const agency = t.filter((x: any) => x.teamType !== 'EMPLOYER'); if (agency.length === 1) setTeamId(agency[0].id); }).catch(setError); }, []);

  return (
    <main className="page">
      <h1>Приглашение от работодателя</h1>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {!token && <p role="alert" className="generation-error">В ссылке нет токена приглашения.</p>}
      {result ? (
        <section className="domain-panel">
          <p className="dtp-status dtp-status--ok">Принято. В вашей команде создан проект подбора с переданными материалами.</p>
          <button type="button" className="primary" onClick={() => router.push(`/domains/interview-pool/${result.agencyProjectId ?? result.projectId ?? ''}`)}>Открыть проект</button>
        </section>
      ) : (
        <section className="domain-panel">
          <p className="card-section__empty">Работодатель передаёт вам вакансию: бриф, параметры, анкету и/или текст — ровно то, что он отметил. Копия ляжет в новый проект вашей команды; отчёты по кандидатам вернутся ему после вашей проверки.</p>
          {!teams && <p className="dtp-muted">Загрузка команд…</p>}
          {teams && teams.filter((t) => t.teamType !== 'EMPLOYER').length === 0 && <p className="card-section__empty">У вас нет команды агентства — создайте её в «Подбор персонала» → «Команда», затем откройте ссылку ещё раз.</p>}
          {teams && teams.length > 0 && (
            <label>Команда агентства<br />
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">— выберите —</option>
                {teams.filter((t) => t.teamType !== 'EMPLOYER').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="primary" disabled={busy || !teamId || !token} onClick={async () => { setBusy(true); setError(null); try { setResult(await employerApi.accept({ token, teamId })); haptic('success'); } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? '…' : 'Принять приглашение'}</button>
        </section>
      )}
    </main>
  );
}
