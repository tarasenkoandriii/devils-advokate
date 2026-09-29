'use client';

// Пункт [delete-project] 2026-09-04 — удаление проекта из интерфейса.
//
// Маршрут `DELETE /projects/:id` существовал, был закрыт проверкой
// владения и с Пункта [project-deletion] возвращал честный список того,
// что переживает удаление. Вызвать его было НЕОТКУДА: ни одного клиента,
// ни одной кнопки. Человек, желавший убрать один проект, мог только
// удалить весь аккаунт. Экран приватности при этом сообщал: «Удаление
// отдельного проекта — на его странице». Указание на кнопку, которой
// нет, хуже её отсутствия: оно закрывает вопрос.
//
// ТРИ РЕШЕНИЯ ЭТОГО ЭКРАНА.
//
// 1. Подтверждение в два шага, без `window.confirm`. Модальные диалоги
//    браузера внутри Telegram WebView выглядят чужеродно и на части
//    клиентов ведут себя непредсказуемо; в проекте уже есть свой приём —
//    состояние `confirming` на экране приватности. Тот же приём здесь.
//
// 2. Что именно исчезнет — сказано ДО нажатия, а не после. Человек
//    решает по этому тексту, и узнать состав потери постфактум ему уже
//    бесполезно.
//
// 3. Список «что переживает удаление» показывается ПОСЛЕ, и экран не
//    уходит с него сам. Сервер возвращает этот список с Пункта
//    [project-deletion]; если бы клиент его выбросил, вся та работа
//    осталась бы невидимой — честность, которую никто не читает, не
//    отличается от её отсутствия.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteProject, ProjectDeletionResult } from '../lib/features';
import { haptic } from '../lib/telegram';

export function ProjectDeletionSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<ProjectDeletionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const report = await deleteProject(projectId);
      setResult(report);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось удалить проект');
    } finally {
      setDeleting(false);
    }
  }

  if (result) {
    return (
      <section className="card-section">
        <h3>Проект удалён</h3>
        <p>Разговоры, расшифровки, аргументы и находки этого проекта удалены.</p>
        {result.notRemovedHere.length > 0 && (
          <>
            <p className="muted">Что удаление проекта НЕ затрагивает:</p>
            <ul className="card-argument-list">
              {result.notRemovedHere.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {/* Уход со страницы — действие человека, а не автоматический
            редирект: иначе список выше он не успеет прочитать. */}
        <button type="button" onClick={() => router.push('/projects')}>
          К списку проектов
        </button>
      </section>
    );
  }

  return (
    <section className="card-section">
      <h3>Удалить проект</h3>
      {error && <p role="alert" className="generation-error">{error}</p>}
      {confirming ? (
        <>
          <p>
            Будут удалены разговоры и их расшифровки, аргументы, находки, договорённости и
            запланированные напоминания этого проекта. Отменить это нельзя.
          </p>
          <button type="button" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Удаляем…' : 'Да, удалить проект'}
          </button>{' '}
          <button type="button" onClick={() => setConfirming(false)} disabled={deleting}>
            Отмена
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          Удалить проект
        </button>
      )}
    </section>
  );
}
