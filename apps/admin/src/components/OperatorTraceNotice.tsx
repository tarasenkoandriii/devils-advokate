'use client';

// Пункт [operator-left-a-trace-unsaid] 2026-09-25 — один текст на все
// экраны оператора.
//
// НАЙДЕНО. Экранов админки, выполняющих действия, которые ОБЯЗАНЫ
// оставлять след, — пять. Говорили о записи в журнал два. Молчали три:
// модерация библиотеки, модерация заведений, промпты. А человек с
// прошлой сверки читает эти решения у себя в Центре приватности словами.
//
// ПОЧЕМУ КОМПОНЕНТ, А НЕ ТРИ ПОДПИСИ РУКАМИ. Ровно так родился дефект
// пункта [screen-said-what-server-unsaid]: две копии одного текста, из
// которых исправили одну. Здесь копий было бы пять.
//
// И СЛЕД РАЗНЫЙ У РАЗНЫХ ДЕЙСТВИЙ. На экране заведений одобрение и
// отклонение заявки человек УВИДИТ (заявка — его запись), а признак
// приоритетного партнёра и вознаграждение за переход — нет (запись
// принадлежит заведению). Промпты не видны никому из людей. Поэтому
// компонент не пишет общих слов, а перечисляет действия ЭТОГО экрана —
// каждое со своим ответом, который посчитал сервер.

import { useEffect, useState } from 'react';

import { getOperatorTraces, type OperatorTrace } from '../lib/endpoints';

/** Разметка предупреждения на ГОТОВЫХ данных.
 *
 * Отдельно от загрузки намеренно: загрузка живёт в `useEffect`, которого
 * при серверном рисовании нет, и проверка была бы вынуждена повторить
 * разметку у себя — то есть проверять копию, а не компонент. Тот же
 * дефект, что продукт чинит снаружи. */
export function OperatorTraceList({
  traces,
  actions,
  always,
}: {
  traces: readonly OperatorTrace[];
  actions: readonly string[];
  always: string;
}) {
  const mine = actions.map((a) => traces.find((t) => t.action === a)).filter((t): t is OperatorTrace => Boolean(t));
  // Экран назвал действия, которых сервер не знает как обязательные к
  // следу, — молчать об этом нельзя: либо экран назвал их неверно, либо
  // действие выпало из правила.
  const unknown = actions.filter((a) => !traces.some((t) => t.action === a));
  if (mine.length === 0 && unknown.length === 0) return null;

  return (
    <div className="hint" role="note">
      <p>Что останется после ваших действий на этом экране:</p>
      <ul>
        {mine.map((t) => (
          <li key={t.action}>
            <strong>{t.what}</strong> (<code>{t.action}</code>) — записывается в журнал;{' '}
            {t.visibleToPerson ? (
              <>человек увидит это решение у себя, в разделе «Что о вас решали».</>
            ) : (
              <>человеку не показывается: {t.whyNotVisible}</>
            )}
          </li>
        ))}
        {unknown.map((a) => (
          <li key={a}>
            <code>{a}</code> — этого действия нет в списке обязательных к следу. Либо экран назвал его
            неверно, либо оно выпало из правила: скажите разработчикам, не считайте, что следа нет.
          </li>
        ))}
      </ul>
      {always && <p>{always}</p>}
    </div>
  );
}

/** Действия, о которых говорит экран. Имена — как в журнале: экран
 * называет их сам, потому что только он знает, что на нём делают. */
export function OperatorTraceNotice({ actions }: { actions: readonly string[] }) {
  const [traces, setTraces] = useState<OperatorTrace[] | null>(null);
  const [always, setAlways] = useState<string>('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void getOperatorTraces()
      .then((r) => {
        setTraces(r.traces);
        setAlways(r.always);
      })
      .catch(() => setFailed(true));
  }, []);

  // Сбой загрузки не молчит: оператор должен знать, что предупреждения
  // нет не потому, что следа нет.
  if (failed) {
    return (
      <p className="hint" role="note">
        Не удалось получить список того, что оставляют ваши действия на этом экране. След всё равно
        остаётся — считайте, что каждое решение записано.
      </p>
    );
  }
  if (!traces) return null;
  return <OperatorTraceList traces={traces} actions={actions} always={always} />;
}
