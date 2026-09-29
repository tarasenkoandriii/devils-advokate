'use client';

// Фаза C — принятие переданного профиля кандидата по ссылке-приглашению
// (candidate-shares/:token/preview → :shareId/accept). Открывается членом
// команды-получателя внутри Mini App.
//
// АУДИТ 2026-09-02: экран не работал НИКОГДА, по двум причинам сразу.
//  1. `previewShare` возвращает МАССИВ (пакетная ссылка — несколько
//     кандидатов), а экран читал `preview.shareId` у массива → в путь
//     подставлялся сам токен, и accept получал 404.
//  2. `acceptShare` требует токен В ТЕЛЕ запроса (фикс IDOR: одного
//     shareId, внутреннего cuid, недостаточно) — тело уходило пустым.
// Плюс сам экран был недостижим: ссылку никто не показывал, а
// start_param приложение не читало вовсе. Здесь чинится экран; ссылку
// показывает InterviewPoolWorkspace, переход по start_param — главная
// страница через lib/start-param.ts.
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { domainApi } from '../../../lib/domains/api';
import { selfShareApi } from '../../../lib/hiring/api';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

// Пункт [job-domain-v2] К-8 — самошеринг соискателя ходит по тому же префиксу
// `share_`, но это ДРУГОЙ объект: превью — /candidate-shares/self/:token/preview,
// принятие — POST /candidate-shares/accept {token, projectId} в проект агентства
// или работодателя (не в «базу команды»). Экран сначала пробует командную
// передачу, на 404 — самошеринг.
interface SelfSharePreview {
  shareId: string;
  expiresAt: string;
  accepted: boolean;
  displayName: string;
  cvText: string;
  clauses: Array<{ kind: string; text: string; category: string | null; isRequired: boolean; candidatePosition: { coverage: string | null; stance: string | null; quote: string | null } | null }>;
  vacancyTitle: string;
}

function SelfShareView({ token, preview }: { token: string; preview: SelfSharePreview }) {
  const [projects, setProjects] = useState<Array<{ id: string; question: string; mode: string }> | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  useEffect(() => {
    // Пункт [false-success] 2026-09-04: обе загрузки гасили сбой в пустой
    // список, и человек видел пустое «— выберите —». Пустой список
    // означает «у вас нет проектов» — совет завести проект; сбой
    // загрузки означает «попробуйте позже». Разные вещи, а выглядели
    // одинаково, причём на странице, где человек принимает чужие данные.
    let failed = false;
    void Promise.all([
      domainApi.getJson('/interview-pool/projects').catch(() => { failed = true; return { items: [] }; }),
      domainApi.getJson('/employer-hiring/projects').catch(() => { failed = true; return { items: [] }; }),
    ]).then(([a, b]) => {
      setProjects([...(a.items ?? a ?? []), ...(b.items ?? b ?? [])]);
      setProjectsFailed(failed);
    });
  }, []);
  return (
    <section className="domain-panel">
      <p className="card-section__empty">Соискатель сам передаёт вам резюме под вакансию «{preview.vacancyTitle}» и отмеченные им пункты. Это его согласие на обработку у вас; он может отозвать его в любой момент — тогда профиль у вас будет помечен.</p>
      <h2>{preview.displayName}</h2>
      <pre className="script-text">{preview.cvText}</pre>
      {preview.clauses.length > 0 && (
        <>
          <h3>Что соискатель показал из своего листа</h3>
          <ul>{preview.clauses.map((c, i) => <li key={i}>{c.text}{c.candidatePosition?.quote ? <span className="dtp-muted"> · «{c.candidatePosition.quote}»</span> : null}</li>)}</ul>
        </>
      )}
      {error && <p role="alert" className="generation-error">{error}</p>}
      {done ? <p className="dtp-status dtp-status--ok">Принято в проект — кандидат появится в списке с пометкой «от соискателя».</p>
        : preview.accepted ? <p className="card-section__empty">Эта ссылка уже принята ранее.</p> : (
          <>
            {projectsFailed && (
              <p role="alert" className="generation-error">
                Список ваших проектов загрузился не полностью — если нужного здесь нет, обновите страницу. Пустой список не означает, что проектов у вас нет.
              </p>
            )}
            <label>В какой проект принять<br />
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">— выберите —</option>
                {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.mode === 'EMPLOYER_HIRING' ? 'Найм: ' : 'Подбор: '}{p.question}</option>)}
              </select>
            </label>
            <button type="button" className="primary" disabled={busy || !projectId} onClick={async () => { setBusy(true); setError(null); try { await selfShareApi.accept(token, projectId); haptic('success'); setDone(true); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось принять'); } finally { setBusy(false); } }}>{busy ? 'Принимаем…' : 'Принять в проект'}</button>
          </>
        )}
    </section>
  );
}

interface SharePreviewItem {
  shareId: string;
  displayName: string | null;
  resumeText: string | null;
  /** Уже принят кем-то ранее (аудит 2026-09-02) — кнопки «Принять» нет. */
  accepted?: boolean;
}

export default function CandidateSharePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [items, setItems] = useState<SharePreviewItem[] | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfShare, setSelfShare] = useState<SelfSharePreview | null>(null);
  useBackButton(() => router.push('/domains/interview-pool'));

  useEffect(() => {
    let cancelled = false;
    domainApi
      .getJson(`/candidate-shares/${token}/preview`)
      .then((data) => {
        if (cancelled) return;
        // Пакетная ссылка отдаёт несколько кандидатов, одиночная —
        // массив из одного. Нормализуем, чтобы экран был один.
        setItems(Array.isArray(data) ? (data as SharePreviewItem[]) : [data as SharePreviewItem]);
      })
      .catch((e) => {
        if (cancelled) return;
        // 404 командной передачи → возможно, это самошеринг соискателя
        selfShareApi.preview(token)
          .then((p) => { if (!cancelled) { setSelfShare(p as SelfSharePreview); setItems([]); } })
          .catch(() => { if (!cancelled) setError(e instanceof Error ? e.message : 'Ссылка недействительна'); });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept(shareId: string) {
    setBusyId(shareId);
    setError(null);
    try {
      // Токен — В ТЕЛЕ: принятие требует и id, и то, что получатель
      // реально получил в ссылке.
      await domainApi.postJson(`/candidate-shares/${shareId}/accept`, { token });
      haptic('success');
      setAccepted((a) => ({ ...a, [shareId]: true }));
    } catch (e) {
      haptic('error');
      setError(e instanceof Error ? e.message : 'Не удалось принять');
    } finally {
      setBusyId(null);
    }
  }

  if (selfShare) {
    return (
      <main className="page">
        <h1>Резюме от соискателя</h1>
        <SelfShareView token={token} preview={selfShare} />
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Профиль кандидата</h1>
      {/* Пункт [candidate-rights] 2026-09-04: у самошеринга (соседняя
          ветка этого же экрана) основание названо прямо — «это его
          согласие, он может отозвать». В командной передаче не было
          сказано НИЧЕГО: человек принимал чужие данные в свою базу одной
          кнопкой. Правило в продукте было, просто не везде — и молчало
          оно там, где данные пересекают границу организации. */}
      <p className="card-section__empty">
        Это данные человека, переданные вам другой командой. Основание — его согласие: он может отозвать его в любой момент, и тогда ссылка перестанет открываться, а профиль у вас будет помечен как отозванный. Оценок и рейтингов кандидата здесь нет — только то, что он о себе сообщил.
      </p>
      {error && <p role="alert" className="generation-error">{error}</p>}
      {!items && !error && <p>Загрузка…</p>}
      {items && items.length === 0 && <p className="card-section__empty">По этой ссылке нет ни одного профиля.</p>}
      <ul className="domain-entities">
        {(items ?? []).map((item) => (
          <li key={item.shareId} className="domain-entities__item">
            <h2>{item.displayName ?? 'Без имени'}</h2>
            {item.resumeText && <p className="domain-entities__body">{item.resumeText}</p>}
            {accepted[item.shareId] ? (
              <p>Добавлен в вашу базу.</p>
            ) : item.accepted ? (
              <p className="card-section__empty">Этот профиль по ссылке уже принят ранее.</p>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busyId === item.shareId}
                onClick={() => accept(item.shareId)}
              >
                {busyId === item.shareId ? 'Принимаем…' : 'Принять в свою команду'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {Object.keys(accepted).length > 0 && (
        <p>
          <a href="/domains/interview-pool">К подбору персонала →</a>
        </p>
      )}
    </main>
  );
}
