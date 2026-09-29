// Пункт [right-with-no-door] 2026-09-25 — право названо, двери нет.
//
// НАЙДЕНО. Решения, принятые О ЧЕЛОВЕКЕ оператором продукта —
// ограничение доступа, блокировка, заморозка его проекта, открытие
// карточки его проекта при разборе обращения — существовали ровно в
// одном месте, доступном человеку: внутри JSON-файла, который он может
// скачать на экране приватности. В приложении внутри Telegram, на
// телефоне.
//
// При этом продукт сам говорит ему — в списке «что остаётся после
// удаления аккаунта», который человек читает перед удалением, — что
// запись о решении «единственное свидетельство того, что решение
// принималось, и то, чем его можно оспорить». Продукт называет право и
// не открывает к нему двери.
//
// МЕРА. Разделов в выгрузке пятнадцать. У четырнадцати есть экран, где
// то же самое видно человеческим образом: проекты, люди, согласия,
// заявки заведений, библиотека, переданные ссылки, голосовой отпечаток,
// журнал Safe Share и прочее. Без экрана остался ОДИН раздел — решения.
// Поэтому здесь не «показать выгрузку экраном», а закрыть единственный
// пробел, который измерение и нашло.
//
// ЧЕСТНЫЕ ГРАНИЦЫ.
//   • Заметка оператора не показывается — её и не запрашивают. Это его
//     рабочая формулировка, а не факт о человеке.
//   • Незнакомое действие не переводится наугад: рядом с машинным именем
//     стоит «название действия не расшифровано, спросите поддержку»
//     (приходит с сервера). Выдуманная подпись хуже непонятной:
//     непонятную человек переспросит, а выдуманной поверит.
//   • Машинное имя показывается ВСЕГДА, даже когда подпись есть: по нему
//     человек и поддержка говорят об одной и той же записи.
//   • Дата форматируется ЗДЕСЬ, в часовом поясе человека (пункт
//     [server-said-which-day]): сервер не называет календарный день.
//   • Обрезанный список говорит, что он обрезан.

import type { DecisionGroup, DecisionsAboutYou as DecisionsPayload, DescribedDecision } from '../lib/features';
import { TruncatedListNotice } from './TruncatedListNotice';

/** Момент времени человеку — в его часовом поясе, а не в серверном. */
export function decisionMoment(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function DecisionRow({ decision }: { decision: DescribedDecision }) {
  return (
    <li className="card-argument-list__item">
      <strong>{decision.what}</strong>
      <br />
      <span className="muted">
        {decisionMoment(decision.at)}
        {decision.by ? ` · ${decision.by}` : ''}
        {' · '}
        <code>{decision.action}</code>
      </span>
    </li>
  );
}

function DecisionGroup({
  title,
  group,
  empty,
}: {
  title: string;
  group: DecisionGroup;
  empty: string;
}) {
  return (
    <>
      <p className="muted">{title}</p>
      {group.items.length === 0 ? (
        <p className="card-section__empty">{empty}</p>
      ) : (
        <>
          <ul className="card-argument-list">
            {group.items.map((d) => (
              <DecisionRow key={`${d.action}-${d.at}-${d.resourceId}`} decision={d} />
            ))}
          </ul>
          {/* Подпись об обрезке — общая на весь продукт, а не своя.
              Первая версия этого раздела написала свою, и сверка
              `silent-failure-conventions` справедливо это поймала:
              «правило было, просто не везде» — и не там, где его ввёл я
              сам. */}
          <TruncatedListNotice hasMore={group.hasMore} limit={group.limit} what="решений" where="в журнале" />
          {group.hasMore && (
            <p className="dtp-hint">
              Полный список за всё время — в выгрузке данных; чтобы разобраться с конкретным решением,
              напишите в поддержку, назвав дату.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function DecisionsAboutYouSection({ decisions }: { decisions: DecisionsPayload | null }) {
  if (!decisions) return null;
  return (
    <section className="card-section">
      <h3>Что о вас решали</h3>
      <p className="card-section__empty">
        Решения, принятые о вашем аккаунте и ваших проектах стороной продукта. Рабочие заметки оператора
        сюда не входят — это его формулировка, а не факт о вас.
      </p>
      <DecisionGroup
        title="Об аккаунте:"
        group={decisions.accountDecisions}
        empty="Решений о вашем аккаунте не принималось."
      />
      <DecisionGroup
        title="О ваших проектах:"
        group={decisions.projectDecisions}
        empty="Решений о ваших проектах не принималось."
      />
      {/* Пункт [door-opened-onto-a-corner] 2026-09-25: без этой группы
          экран дотягивался до девяти расшифрованных действий из
          тридцати четырёх — и пустой раздел при этом УТВЕРЖДАЛ, что
          решений не принималось. */}
      <DecisionGroup
        title="О ваших записях — заявках, профиле кандидата, переданных ссылках:"
        group={decisions.belongingsDecisions}
        empty="Решений о ваших записях не принималось."
      />
      {decisions.outOfScope.length > 0 && (
        <details className="dtp-hint">
          <summary>Что сюда не входит</summary>
          <ul className="card-argument-list">
            {decisions.outOfScope.map((o) => (
              <li key={o.resource}>
                <code>{o.resource}</code> — {o.why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
