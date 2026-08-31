'use client';

// Фаза C — принятие переданного профиля кандидата по ссылке-приглашению
// (candidate-shares/:token/preview → :shareId/accept). Открывается членом
// команды-получателя внутри Mini App.
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { domainApi } from '../../../lib/domains/api';
import { JsonView } from '../../../components/domains/JsonPanel';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function CandidateSharePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useBackButton(() => router.push('/domains/interview-pool'));
  useEffect(() => { domainApi.getJson(`/candidate-shares/${token}/preview`).then(setPreview).catch((e) => setError(e instanceof Error ? e.message : 'Ссылка недействительна')); }, [token]);
  return (
    <main className="page">
      <h1>Профиль кандидата</h1>
      {error && <p className="generation-error">{error}</p>}
      {preview && !done && (
        <>
          <JsonView data={preview} />
          <button type="button" className="primary" onClick={async () => { try { await domainApi.postJson(`/candidate-shares/${preview.shareId ?? preview.id ?? token}/accept`, {}); haptic('success'); setDone(true); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось принять'); } }}>Принять в свою команду</button>
        </>
      )}
      {done && <p>Профиль добавлен. <a href="/domains/interview-pool">К подбору персонала →</a></p>}
    </main>
  );
}
