// Пункт [screen-said-what-server-unsaid] 2026-09-25 — две копии одного
// текста, из которых исправили одну.
//
// Текст «что остаётся после удаления аккаунта» жил в двух местах:
// на сервере (в ответе на удаление) и руками написанным абзацем здесь.
// Пункт [audit-trail] 2026-09-04 исправил серверный — «Журнал аудита
// хранится без персональных данных» оказалось неправдой, — а экранный
// остался с этой же фразой. И читал человек именно экранный: ДО того,
// как решил удалять. Правда лежала там, где уже ничего не решает.
//
// Здесь обе половины берут один и тот же список с сервера: «до» —
// отдельным чтением, «после» — из ответа на удаление.
//
// Вторая половина пункта: отчёт печатался машинными ключами
// («aiInferences: 12, aiJobsCancelled: 3»). Подписи берутся из
// `deletionReportLabel`, а незнакомый ключ показывается как есть —
// придуманная подпись хуже латиницы.

import type { ReactNode } from 'react';

import type { AccountDeletionResult, ThirdPartyLoss } from '../lib/features';
import { deletionReportLabel } from '../lib/field-labels';

/** Что переживает удаление. Пустой список — ничего не рисуется: заголовок
 * «что остаётся» над пустотой сам по себе утверждение, и неверное. */
export function WhatRemainsAfterDeletion({ lines, title }: { lines: readonly string[]; title: string }) {
  if (lines.length === 0) return null;
  return (
    <>
      <p className="muted">{title}</p>
      <ul className="card-argument-list">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/** Строки отчёта, у которых есть что показать.
 *
 * Нули отброшены намеренно: «проектов: 0» не сообщает ничего об удалении
 * и разбавляет то, что сообщает. Если удалять было нечего вовсе, об этом
 * сказано словами, а не девятью нулями. */
export function removedLines(removed: Record<string, number>): Array<{ key: string; label: string; count: number }> {
  return Object.entries(removed)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([key, count]) => ({ key, label: deletionReportLabel(key), count }));
}

/** Что удаление заберёт у ДРУГИХ людей.
 *
 * Пункт [cascade-took-a-stranger] 2026-09-26. Удаление аккаунта каскадом
 * уносит рассказы других людей под разборами в библиотеке, отметки о
 * бронировании в заведении, которое человек подавал, и комментарии тех,
 * кого он сам пригласил в обсуждение по ссылке. До этого пункта экран
 * говорил только о том, что ОСТАЁТСЯ, и человек принимал решение, не
 * зная его последствий для людей, которых продукт сам попросил
 * что-то написать.
 *
 * Пустой список не рисуется: заголовок «заберёт у других» над пустотой —
 * утверждение, и неверное. */
export function TakesFromOthers({ losses, note, title }: { losses: readonly ThirdPartyLoss[]; note: string; title: string }) {
  if (losses.length === 0) return null;
  return (
    <>
      <p role="alert">
        <strong>{title}</strong>
      </p>
      <ul className="card-argument-list">
        {losses.map((l) => (
          <li key={l.key}>
            {l.text} <span className="muted">— {l.why}</span>
          </li>
        ))}
      </ul>
      {note && <p className="muted">{note}</p>}
    </>
  );
}

export function AccountDeletionReport({ result }: { result: AccountDeletionResult }) {
  const lines = removedLines(result.removed);
  const external = result.externalArtifacts;
  return (
    <div className="dtp-status dtp-status--ok">
      <p>Аккаунт удалён.</p>
      {lines.length > 0 ? (
        <ul className="card-argument-list">
          {lines.map((l) => (
            <li key={l.key}>
              {l.label}: {l.count}
            </li>
          ))}
        </ul>
      ) : (
        <p>Данных, которые нужно было удалить, за аккаунтом не числилось.</p>
      )}
      {external.conversationAudioBlobs > 0 && (
        <p>Транзитных аудиофайлов разговоров удалено: {external.conversationAudioBlobs}.</p>
      )}
      {external.sttJobsDiscarded > 0 && (
        <p>Задач распознавания отозвано у провайдера: {external.sttJobsDiscarded}.</p>
      )}
      {external.failed > 0 && (
        <p role="alert">
          Не удалось удалить файлов во внешнем хранилище: {external.failed} — напишите нам, удалим вручную.
        </p>
      )}
      <TakesFromOthers
        losses={result.tookFromOthers}
        note={result.tookFromOthersNote}
        title="Вместе с аккаунтом удалено то, что принадлежит другим людям:"
      />
      <WhatRemainsAfterDeletion lines={result.notRemovedHere} title="Что удаление аккаунта НЕ затрагивает:" />
      <p>При следующем открытии приложение начнёт с чистого листа.</p>
    </div>
  );
}

/** Весь раздел удаления — оба состояния в одном месте.
 *
 * Компонент существует ради проверки, и это не подгонка под тест.
 * Мутация «убрать список из состояния ДО удаления» пережила первую
 * версию правила: та требовала, чтобы имя компонента ВСТРЕЧАЛОСЬ в
 * файле страницы, а импорт остаётся на месте и после того, как вызов
 * убрали. То есть правило было написано на упоминание, а не на
 * поведение — дефект, о котором в проекте есть отдельный пункт
 * ([probe-checked-the-neighbour]), и я повторил его здесь. Пока оба
 * состояния жили внутри страницы с загрузкой данных, нарисовать их в
 * проверке было нельзя; теперь можно — и правило смотрит на разметку.
 */
export function AccountDeletionSection({
  remains,
  takesFromOthers = [],
  takesFromOthersNote = '',
  result,
  intro,
  form,
}: {
  remains: readonly string[];
  takesFromOthers?: readonly ThirdPartyLoss[];
  takesFromOthersNote?: string;
  result: AccountDeletionResult | null;
  intro: ReactNode;
  form: ReactNode;
}) {
  if (result) return <AccountDeletionReport result={result} />;
  return (
    <>
      {intro}
      {/* Пункт [cascade-took-a-stranger] 2026-09-26: последствия для
          ДРУГИХ — выше формы, а не под ней. Ниже кнопки это была бы
          приписка после решения. */}
      <TakesFromOthers
        losses={takesFromOthers}
        note={takesFromOthersNote}
        title="Ваше удаление заберёт и то, что принадлежит другим людям:"
      />
      <WhatRemainsAfterDeletion lines={remains} title="Что удаление аккаунта НЕ затрагивает:" />
      {form}
    </>
  );
}
