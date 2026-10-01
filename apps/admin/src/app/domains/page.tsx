'use client';

// Фаза F — воронка по доменным сценариям: сколько проектов, сколько дошло
// до конфига. Именно это показывает «мёртвый» домен (аудит 2026-08-30 §7.1).
//
// YouTube-разбор — НЕ доменный сценарий (его проекты живут в STANDARD
// как контейнеры очередей, у него нет своей воронки extract→config),
// поэтому в таблицу режимов он не входит. Но спрашивают его здесь —
// отдельный сводный блок ниже, детали на /media-review.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getDomainsSummary, listAdminMediaReviewQueues } from '../../lib/endpoints';
import type { DomainSummaryRow, AdminMediaReviewQueues } from '../../lib/types';

// Пункт [coverage-report-outlived-the-product] 2026-09-24: доменов на
// сервере восемь, здесь их было семь — восьмой рисовался машинным
// ключом «employer-hiring». Подписи держатся тестом против
// `DOMAIN_MODES`, чтобы девятый домен не появился на экране латиницей.
const TITLES: Record<string, string> = { dtp: 'ДТП', 'family-law': 'Семейное право', health: 'Здоровье', 'interview-pool': 'Подбор персонала', investment: 'Инвестиции', 'major-purchase': 'Крупная покупка', 'job-search': 'Поиск работы', 'employer-hiring': 'Наём работодателем' };

export default function DomainsPage() {
  const [rows, setRows] = useState<DomainSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaQueues, setMediaQueues] = useState<AdminMediaReviewQueues | null>(null);
  // Пункт [loading-never-ended] 2026-10-01: здесь стоял
  // `.catch(() => undefined)`, и при отказе API `mediaQueues` оставался
  // null — то есть строка «Загрузка…» ниже висела вечно. Оператор читал
  // СБОЙ как «ещё считается», причём в блоке, по которому решают, жив ли
  // конвейер YouTube-разбора. Соседний экран (`/media-review`) отказ
  // показывает; этот — нет. Своё состояние отказа, а не общий `error`:
  // доменные итоги и очереди медиа — два независимых запроса, и падение
  // второго не должно прятать первый.
  useEffect(() => { getDomainsSummary().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  const [mediaError, setMediaError] = useState<string | null>(null);
  useEffect(() => { listAdminMediaReviewQueues().then(setMediaQueues).catch((e) => setMediaError(e instanceof Error ? e.message : 'Не удалось загрузить очереди медиа')); }, []);

  // Пункт [ceiling-hid-inside-a-total] 2026-09-24: здесь этот экран
  // СКЛАДЫВАЛ полученные очереди в итоги, а сервер отдавал их с
  // необъявленным потолком в 200 строк. Итог по срезу, подписанный как
  // итог по всему, — уверенно показанное неверное число: при девятистах
  // очередях оператор читал «200» и долю разобранных среди последних
  // двухсот. Теперь итоги считает база по всем строкам, и экран их
  // ПОКАЗЫВАЕТ, а не выводит заново.
  const media = mediaQueues
    ? {
        queues: mediaQueues.totals.queues,
        items: mediaQueues.totals.items,
        done: mediaQueues.totals.byStatus?.DONE ?? 0,
        processing: mediaQueues.totals.byStatus?.PROCESSING ?? 0,
        awaiting: mediaQueues.totals.byStatus?.AWAITING_UPLOAD ?? 0,
        stuck: mediaQueues.totals.stuckProcessing,
      }
    : null;
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  return (
    <div className="page">
      <h1>Доменные сценарии</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Проекты по сценариям и доля дошедших до конфига (онбординг → extract → config). Read-only. См. также <Link href="/intake">intake-квиз</Link> и <Link href="/media-review">разбор медиа</Link>.</p>
      {!rows && <p className="muted">Загрузка…</p>}
      {rows && (
        <table>
          <thead><tr><th>Сценарий</th><th>Всего</th><th>7 дн</th><th>30 дн</th><th>С конфигом</th><th>Доля</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.domain}>
                <td><Link href={`/domains/${r.domain}`}>{TITLES[r.domain] ?? r.domain}</Link></td>
                <td>{r.total}</td><td>{r.last7}</td><td>{r.last30}</td><td>{r.withConfig}</td>
                <td>{r.configRate === null ? '—' : <span className={r.configRate < 0.3 ? 'badge badge-bad' : 'badge badge-ok'}>{Math.round(r.configRate * 100)}%</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32 }}>YouTube-разбор (медиа)</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Не доменный сценарий, а отдельный конвейер: очереди публичных видео → автоматический
        мультимодальный разбор (Gemini). Детали и очереди — на вкладке{' '}
        <Link href="/media-review">Медиа</Link>, живой прогон — в <Link href="/sandbox">Sandbox</Link>.
      </p>
      {mediaError && <p role="alert" style={{ color: '#b00' }}>Не удалось загрузить очереди медиа: {mediaError}</p>}
      {!media && !mediaError && <p className="muted">Загрузка…</p>}
      {media && (
        <table>
          <thead>
            <tr><th>Очередей</th><th>Роликов</th><th>Разобрано (DONE)</th><th>В работе</th><th>Ожидают/ошибка</th><th>Доля разобранных</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{media.queues}</td>
              <td>{media.items}</td>
              <td>{media.done}</td>
              <td>{media.processing}{media.stuck > 0 ? ` (застряло: ${media.stuck})` : ''}</td>
              <td>{media.awaiting}</td>
              <td>
                {media.items === 0 ? '—' : (
                  <span className={media.done / media.items < 0.3 ? 'badge badge-bad' : 'badge badge-ok'}>
                    {Math.round((media.done / media.items) * 100)}%
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
