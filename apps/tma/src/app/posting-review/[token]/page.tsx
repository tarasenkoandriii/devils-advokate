'use client';

// Пункт [job-domain-v2] А-18 — публичное согласование текста вакансии
// заказчиком по ссылке: текст редакции и комментарии, без авторизации и без
// compliance-флагов (они — внутренняя кухня агентства).
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getPostingReview, commentPostingReview, PostingReviewView } from '../../../lib/public-api';

export default function PostingReviewPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<PostingReviewView | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => getPostingReview(token).then(setView).catch((e) => setError(e instanceof Error ? e.message : 'Ссылка недействительна'));
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="page">
      <h1>Текст вакансии на согласование</h1>
      {error && <p role="alert" className="generation-error">{error}</p>}
      {!view && !error && <p>Загрузка…</p>}
      {view && (
        <section className="domain-panel">
          <pre className="script-text">{view.text}</pre>
          {view.origins && view.origins.length > 0 && (
            <>
              <h3>Откуда каждый пункт</h3>
              <ul>{view.origins.map((o, i) => <li key={i}>{o.text} — <span className="dtp-muted">{o.label}{o.briefQuote ? `: «${o.briefQuote}»` : ''}</span></li>)}</ul>
            </>
          )}
          <h3>Комментарии</h3>
          {view.comments.length === 0 && <p className="card-section__empty">Комментариев пока нет.</p>}
          <ul>{view.comments.map((c, i) => <li key={i}>{c.text} <span className="dtp-muted">· {c.at ? new Date(c.at).toLocaleString('ru-RU') : ''}</span></li>)}</ul>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Что поправить в тексте" />
          <button type="button" className="primary" disabled={busy || !text.trim()} onClick={async () => { setBusy(true); try { await commentPostingReview(token, text.trim()); setText(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить'); } finally { setBusy(false); } }}>{busy ? '…' : 'Отправить комментарий'}</button>
        </section>
      )}
    </main>
  );
}
