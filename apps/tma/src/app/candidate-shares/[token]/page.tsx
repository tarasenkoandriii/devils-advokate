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
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

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
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ссылка недействительна');
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

  return (
    <main className="page">
      <h1>Профиль кандидата</h1>
      {error && <p className="generation-error">{error}</p>}
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
