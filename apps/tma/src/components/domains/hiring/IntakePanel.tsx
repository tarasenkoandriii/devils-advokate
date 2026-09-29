'use client';

// Пункт [job-domain-v2] связка П — «Приток»: откуда берутся вакансии, кроме
// ссылки по одной. Страница результатов (HTML/ссылка) → кандидаты в базу без
// содержимого → загрузка по одному; ссылки из письма-рассылки; вставленный
// текст; пересылка боту (инструкция); дедупликация; история откликов;
// «молчат N дней». Ничего из этого не ранжирует вакансии — только собирает.
import { useEffect, useState } from 'react';
import { intakeApi } from '../../../lib/hiring/api';
import { AiErrorNotice } from '../AiErrorNotice';
import { EntityForm } from '../EntityForm';
import { JsonView } from '../JsonPanel';
import { haptic } from '../../../lib/telegram';
import { parseLinkLines, unreadableLinesNote } from '../../../lib/form-input';

export function IntakePanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [mode, setMode] = useState<'none' | 'search' | 'email' | 'pasted' | 'responses'>('none');
  const [candidates, setCandidates] = useState<any[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ title: string; data: any } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { intakeApi.candidates(projectId).then(setCandidates).catch(setError); }, [projectId, tick]);
  const bump = () => { setTick((t) => t + 1); onChanged(); };

  async function run<T>(fn: () => Promise<T>, title?: string) {
    setBusy(true); setError(null);
    try { const r = await fn(); haptic('success'); if (title) setOut({ title, data: r }); bump(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <section className="domain-panel">
      <p className="card-section__empty">Сюда попадает всё, что вы нашли сами: страница результатов поиска, ссылки из письма-рассылки, скопированный текст. Приложение сохраняет как есть и сверяет с вашими критериями — но не решает, что «лучше».</p>
      <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />
      {mode === 'none' && (
        <div className="entity-form__actions">
          <button type="button" className="secondary" onClick={() => setMode('search')}>Страница результатов</button>
          <button type="button" className="secondary" onClick={() => setMode('email')}>Ссылки из письма</button>
          <button type="button" className="secondary" onClick={() => setMode('pasted')}>Вставить текст</button>
          <button type="button" className="secondary" onClick={() => setMode('responses')}>История откликов</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => run(() => intakeApi.dedupe(projectId), 'Дубликаты')}>Найти дубликаты</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => run(() => intakeApi.silence(projectId), 'Кто молчит')}>Кто молчит 7+ дней</button>
        </div>
      )}
      {mode === 'search' && (
        <EntityForm
          fields={[{ name: 'url', label: 'Ссылка на страницу результатов', type: 'url', hint: 'или вставьте HTML страницы ниже' }, { name: 'html', label: 'HTML страницы (если ссылка не открывается)', type: 'textarea' }]}
          submitLabel="Разобрать" onCancel={() => setMode('none')}
          onSubmit={async (v) => { setOut({ title: 'Найдено на странице', data: await intakeApi.searchPage(projectId, v as any) }); setMode('none'); bump(); }}
        />
      )}
      {mode === 'email' && (
        <EntityForm
          fields={[{ name: 'links', label: 'Ссылки из письма — по одной в строке', type: 'textarea', required: true, hint: 'Можно с заголовком через « — »: https://… — Название вакансии' }]}
          submitLabel="Добавить кандидатов" onCancel={() => setMode('none')}
          /* Пункт [own-input] 2026-09-04: разбор вынесен в чистую функцию —
             внутри обработчика его нельзя ни вызвать из теста, ни
             спросить, что он выбросил. Нечитаемые строки теперь
             возвращаются человеку целиком: это его собственный текст, и
             увидев его, он сразу заметит перевёрнутую строку или
             опечатку. */
          onSubmit={async (v) => {
            const { links, unreadable } = parseLinkLines(String(v.links));
            if (links.length === 0) { setOut({ title: 'Из письма', data: { unreadable, note: unreadableLinesNote(unreadable) } }); setMode('none'); return; }
            setOut({ title: 'Из письма', data: { ...(await intakeApi.emailAlert(projectId, links)), unreadable, note: unreadableLinesNote(unreadable) } }); setMode('none'); bump();
          }}
        />
      )}
      {mode === 'pasted' && (
        <EntityForm
          fields={[{ name: 'text', label: 'Текст вакансии', type: 'textarea', required: true }, { name: 'title', label: 'Название', type: 'text' }, { name: 'sourceUrl', label: 'Ссылка (если есть)', type: 'url' }]}
          submitLabel="Сохранить как вакансию" onCancel={() => setMode('none')}
          onSubmit={async (v) => { await intakeApi.pasted(projectId, v as any); setMode('none'); bump(); }}
        />
      )}
      {mode === 'responses' && (
        <EntityForm
          fields={[{ name: 'text', label: 'Экспорт откликов с площадки (текст)', type: 'textarea', required: true, hint: 'Строки вида «дата · вакансия · статус» — приложение сопоставит с вашими вакансиями' }]}
          submitLabel="Импортировать" onCancel={() => setMode('none')}
          onSubmit={async (v) => { setOut({ title: 'Импорт откликов', data: await intakeApi.responses(projectId, String(v.text)) }); setMode('none'); bump(); }}
        />
      )}
      <p className="dtp-hint">Пересылка боту: перешлите сообщение с вакансией в бот — текст сохранится в этот проект. Личность автора пересланного сообщения не сохраняется.</p>

      {out && (
        <div className="dtp-card">
          <div className="dtp-card__head dtp-card__head--static"><span>{out.title}</span><button type="button" className="dtp-link" onClick={() => setOut(null)}>скрыть</button></div>
          <div className="dtp-card__body"><JsonView data={out.data} /></div>
        </div>
      )}

      <h3>Кандидаты в базу</h3>
      {/* Пункт [silent-destruction] 2026-09-04: здесь было написано
          «удалятся при переполнении», а код удаляет ПО ВОЗРАСТУ — через
          30 дней, независимо от заполненности. Человек сохранял
          вакансию, не загружал её и терял через месяц, хотя надпись
          обещала, что она лежит, пока база не заполнится. Правило одно, и
          названо оно теперь то, которое действует. */}
      <p className="dtp-muted">Ссылка и заголовок — без содержимого. <strong>Незагруженный кандидат удаляется через 30 дней</strong> — загрузите то, что хотите сохранить; загруженные не удаляются. Потолок базы — 200: сверх него новые не добавляются, пока не освободите место.</p>
      {candidates && candidates.length === 0 && <p className="card-section__empty">Пока пусто.</p>}
      <ul className="domain-entities">
        {(candidates ?? []).map((c: any) => (
          <li key={c.id} className="domain-entities__item">
            <div className="domain-entities__title">
              {c.title} <span className="dtp-muted">· {c.url ?? "без ссылки"}{c.company ? ` · ${c.company}` : ""}</span>
              {c.fetchedVacancyId ? <span className="domain-badge"> загружена</span> : <button type="button" className="dtp-link" disabled={busy} onClick={() => run(() => intakeApi.fetchCandidate(c.id))}> загрузить</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
