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
//
// 4. Пункт [project-deletion-took-a-stranger] 2026-09-30. Решение 2
//    выше исполнялось НАПОЛОВИНУ: «что именно исчезнет» перечисляло
//    только СВОЁ — разговоры, расшифровки, аргументы, находки. А вместе
//    с проектом исчезают слова приглашённых в обсуждение, отчёты,
//    переданные заказчику, и запись о договорённости у агентства.
//    Правило было объявлено в этой самой шапке и закрывало вопрос,
//    которого не решало. Теперь чужие потери спрашиваются у сервера
//    ДО подтверждения и называются числом и словами — и повторяются
//    ПОСЛЕ, тем же списком.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteProject,
  projectDeletionPreview,
  ProjectDeletionResult,
  ProjectLoss,
} from '../lib/features';
import { haptic } from '../lib/telegram';

/** Что удаление заберёт у других — отдельным компонентом, чтобы его
 *  можно было НАРИСОВАТЬ в проверке с данными и без.
 *
 *  Пустой список не рисует ничего: заголовок над пустотой сам по себе
 *  утверждение, и неверное. */
export function ThirdPartyLosses({
  losses,
  note,
  title,
}: {
  losses: ProjectLoss[];
  note: string;
  title: string;
}) {
  if (losses.length === 0) return null;
  return (
    <>
      <p className="generation-error" role="status">
        {title}
      </p>
      <ul className="card-argument-list">
        {losses.map((l) => (
          <li key={l.key}>
            {l.text} — <span className="muted">{l.why}</span>
          </li>
        ))}
      </ul>
      <p className="muted">{note}</p>
    </>
  );
}

/** Текст подтверждения целиком — отдельным компонентом, чтобы его можно
 *  было НАРИСОВАТЬ в проверке во всех трёх состояниях: чужие потери
 *  посчитаны, посчитать не удалось, чужого нет.
 *
 *  Раньше это была разметка внутри ветки `confirming`, и проверить её
 *  можно было только сверкой по тексту исходника — мутация «спрятать
 *  список за `false`» её проходила насквозь. */
export function DeletionConfirmNotice({
  takes,
  previewFailed,
}: {
  takes: { losses: ProjectLoss[]; note: string } | null;
  previewFailed: boolean;
}) {
  return (
    <>
      <p>
        Будут удалены разговоры и их расшифровки, аргументы, находки, договорённости и запланированные
        напоминания этого проекта. Отменить это нельзя.
      </p>
      {takes && (
        <ThirdPartyLosses losses={takes.losses} note={takes.note} title="Удаление заберёт и у других людей:" />
      )}
      {previewFailed && (
        <p className="muted" role="status">
          Не удалось посчитать, что удаление заберёт у других. Это не значит «ничего»: посчитать не
          получилось. Попробуйте открыть подтверждение ещё раз.
        </p>
      )}
    </>
  );
}

/** Отчёт после удаления — отдельным компонентом по той же причине, что
 *  и текст подтверждения: иначе его нечем нарисовать в проверке, и
 *  мутация «скрыть забранное у других» проходит насквозь. */
export function DeletionReport({ result }: { result: ProjectDeletionResult }) {
  return (
    <>
      <p>Разговоры, расшифровки, аргументы и находки этого проекта удалены.</p>
      <ThirdPartyLosses
        losses={result.tookFromOthers}
        note={result.tookFromOthersNote}
        title="Удаление забрало у других людей:"
      />
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
    </>
  );
}

export function ProjectDeletionSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<ProjectDeletionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [takes, setTakes] = useState<{ losses: ProjectLoss[]; note: string } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  // Спрашивается при переходе к подтверждению, а не при открытии
  // страницы: считать чужие потери на каждом заходе в проект —
  // запросы ради экрана, который человек чаще всего не откроет.
  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    projectDeletionPreview(projectId)
      .then((p) => {
        if (!cancelled) setTakes({ losses: p.takesFromOthers, note: p.takesFromOthersNote });
      })
      .catch(() => {
        // Молчать нельзя: человек решит, что чужого нет. Говорим, что
        // не смогли посчитать, — это другое утверждение.
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [confirming, projectId]);

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
        <DeletionReport result={result} />
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
          <DeletionConfirmNotice takes={takes} previewFailed={previewFailed} />
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
