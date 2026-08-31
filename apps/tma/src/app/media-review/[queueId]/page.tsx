'use client';

// Очередь: поиск YouTube → добавить → привязать запись разговора →
// статус синхронизируется с Conversation.status (READY→PROCESSING→DONE,
// баг застревания в PROCESSING закрыт аудитом) → сводка сигналов.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { mediaReviewApi, MediaReviewQueueItem, MediaReviewSummary, YouTubeSearchResult } from '../../../lib/media-review';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

const STATUS_LABEL: Record<string, string> = { AWAITING_UPLOAD: 'без записи', READY: 'записано', PROCESSING: 'анализ…', DONE: 'готово' };

export default function MediaReviewQueuePage() {
  const { queueId } = useParams<{ queueId: string }>();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<MediaReviewQueueItem[]>([]);
  const [summary, setSummary] = useState<MediaReviewSummary | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState('');
  useBackButton(() => router.push('/media-review'));

  const reload = useCallback(async () => {
    const [q, s] = await Promise.all([mediaReviewApi.getQueue(queueId), mediaReviewApi.getSummary(queueId)]);
    setTitle(q.title); setItems(q.items); setSummary(s);
  }, [queueId]);

  useEffect(() => { reload().catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, [reload]);

  // Пока есть PROCESSING — опрашиваем раз в 15 с (GET сам синхронизирует статусы).
  useEffect(() => {
    if (!items.some((i) => i.status === 'PROCESSING')) return;
    const t = setInterval(() => reload().catch(() => undefined), 15_000);
    return () => clearInterval(t);
  }, [items, reload]);

  async function search() {
    if (!query.trim()) return;
    setBusy(true); setError(null);
    try { setResults(await mediaReviewApi.search(query.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : 'Поиск недоступен (лимит или нет ключа YouTube)'); }
    finally { setBusy(false); }
  }

  async function add(r: YouTubeSearchResult) {
    setBusy(true); setError(null);
    try { await mediaReviewApi.addItem(queueId, r); haptic('success'); setResults((prev) => prev.filter((x) => x.videoId !== r.videoId)); await reload(); }
    catch (e) { haptic('error'); setError(e instanceof Error ? e.message : 'Не удалось добавить'); }
    finally { setBusy(false); }
  }

  async function link(itemId: string) {
    if (!conversationId.trim()) return;
    setBusy(true); setError(null);
    try { await mediaReviewApi.linkConversation(itemId, conversationId.trim()); haptic('success'); setLinkFor(null); setConversationId(''); await reload(); }
    catch (e) { haptic('error'); setError(e instanceof Error ? e.message : 'Не удалось привязать'); }
    finally { setBusy(false); }
  }

  return (
    <main className="page">
      <p><Link href="/media-review">← Очереди</Link></p>
      <h1>{title || '…'}</h1>
      {summary && (
        <div className="domain-budget__summary">
          <div className="domain-budget__currency"><strong>{summary.doneItems}/{summary.totalItems}</strong><span>разобрано</span></div>
          <div className="domain-budget__currency"><strong>{summary.manipulationSignals}</strong><span>манипуляций</span></div>
          <div className="domain-budget__currency"><strong>{summary.discrepancySignals}</strong><span>расхождений</span></div>
        </div>
      )}
      {error && <p className="generation-error">{error}</p>}

      <section className="domain-panel">
        <h3>Добавить видео</h3>
        <div className="voice-text-input__row" style={{ width: '100%' }}>
          <input style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск на YouTube" onKeyDown={(e) => e.key === 'Enter' && search()} />
          <button type="button" className="secondary" disabled={busy || !query.trim()} onClick={search}>Найти</button>
        </div>
        <ul className="domain-entities">
          {results.map((r) => (
            <li key={r.videoId} className="domain-entities__item">
              <div className="domain-sessions__head">
                <span><strong>{r.title}</strong><br /><small>{r.channelName}{r.durationSeconds ? ` · ${Math.round(r.durationSeconds / 60)} мин` : ''}</small></span>
                <button type="button" className="secondary" disabled={busy} onClick={() => add(r)}>+ в очередь</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="domain-panel">
        <h3>Очередь</h3>
        {items.length === 0 && <p className="card-section__empty">Пусто — найдите и добавьте видео.</p>}
        <ol className="domain-entities" style={{ paddingLeft: 0 }}>
          {items.map((it) => (
            <li key={it.id} className="domain-entities__item">
              <div className="domain-sessions__head">
                <span><strong>{it.title}</strong><br /><small>{it.channelName}</small></span>
                <span className="domain-badge">{STATUS_LABEL[it.status] ?? it.status}</span>
              </div>
              {/* Пункт [multimodal] §6.4: если автоматика не сработала —
                  показываем причину, ручной путь остаётся доступным. */}
              {it.autoAnalysisError && (
                <p className="card-section__empty" style={{ marginTop: 6 }}>
                  Авто-разбор: {it.autoAnalysisError}
                </p>
              )}
              {it.status === 'PROCESSING' && it.conversation?.status === 'ANALYZING' && (
                <p className="card-section__empty" style={{ marginTop: 6 }}>
                  Идёт автоматический разбор — видео анализирует провайдер по ссылке, приложение файл не скачивает.
                </p>
              )}
              {it.status === 'AWAITING_UPLOAD' && (
                linkFor === it.id ? (
                  <div className="entity-form">
                    <label className="entity-form__field">
                      <span>ID записи разговора</span>
                      <input value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
                      <small>Загрузите аудио этого видео в разделе «Разговоры» любого проекта и скопируйте ID записи — само видео приложение не скачивает.</small>
                    </label>
                    <div className="entity-form__actions">
                      <button type="button" className="primary" disabled={busy || !conversationId.trim()} onClick={() => link(it.id)}>Привязать</button>
                      <button type="button" className="secondary" onClick={() => setLinkFor(null)}>Отмена</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="secondary" onClick={() => setLinkFor(it.id)}>Привязать запись</button>
                )
              )}
              {it.conversation?.projectId && it.status === 'DONE' && <Link href={`/projects/${it.conversation.projectId}`} className="domain-badge">открыть разбор</Link>}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
