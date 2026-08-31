'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mediaReviewApi, MediaReviewQueue } from '../../lib/media-review';
import { useBackButton } from '../../hooks/useBackButton';

export default function MediaReviewQueuesPage() {
  const router = useRouter();
  const [queues, setQueues] = useState<MediaReviewQueue[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useBackButton(() => router.push('/domains'));

  useEffect(() => { mediaReviewApi.listQueues().then(setQueues).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);

  async function create() {
    if (!title.trim()) return;
    setBusy(true); setError(null);
    try { const q = await mediaReviewApi.createQueue(title.trim()); router.push(`/media-review/${q.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать'); setBusy(false); }
  }

  return (
    <main className="page">
      <h1>🎬 Разбор медиа</h1>
      <p className="card-section__empty">Очередь публичных дискуссий (YouTube): к каждому видео привязывается загруженная запись разговора, дальше работают те же детекторы манипуляций и расхождений.</p>
      <div className="entity-form">
        <label className="entity-form__field"><span>Название очереди</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: дебаты кандидатов, сезон 2026" /></label>
        <div className="entity-form__actions"><button type="button" className="primary" disabled={busy || !title.trim()} onClick={create}>Создать очередь</button></div>
      </div>
      {error && <p className="generation-error">{error}</p>}
      {queues.length === 0 && !error && <p className="card-section__empty">Очередей пока нет.</p>}
      <ul className="project-list">
        {queues.map((q) => (
          <li key={q.id}><Link href={`/media-review/${q.id}`}>
            <span className="project-list__question">{q.title}</span>
            <span className="project-list__meta">{q._count?.items ?? 0} видео</span>
          </Link></li>
        ))}
      </ul>
    </main>
  );
}
