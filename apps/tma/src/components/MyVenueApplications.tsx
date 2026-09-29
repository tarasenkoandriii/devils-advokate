'use client';

// Пункт [own-submission] 2026-09-04 — свои заявки и их судьба.
//
// НАЙДЕНО: маршрут `venue-applications/mine` был на сервере с самого
// начала и не вызывался НИКЕМ — ни обёртки в клиенте, ни экрана. Готовый
// бэкенд с нулевым UI, та же форма, что в Пунктах 27 и 28, и с тем же
// следствием: право, о котором человек не может узнать, для него не
// существует. Отправив заявку, он видел «проходит модерацию — появится
// в каталоге после одобрения» и, уйдя со страницы, терял и это: вернуться
// к своей заявке было некуда.
//
// Отдельным компонентом — чтобы сверка его РИСОВАЛА (урок
// [render-guards]: проверка на упоминание текста в исходнике проходит и
// у выключенного экрана).

import { useEffect, useState } from 'react';
import { listMyVenueApplications } from '../lib/features';
import { venueApplicationOutcome } from '../lib/submission-status';
import type { VenueApplication } from '../lib/types';

export function MyVenueApplications() {
  const [rows, setRows] = useState<VenueApplication[] | null>(null);
  // «Не смогли спросить» и «заявок нет» — разные утверждения, и второе
  // нельзя показывать вместо первого (урок Пункта [false-success]).
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listMyVenueApplications()
      .then(setRows)
      .catch(() => setFailed(true));
  }, []);

  return <MyVenueApplicationsView rows={rows} failed={failed} />;
}

/** Отдельно от загрузки — чтобы сверка могла НАРИСОВАТЬ этот экран с
 * данными, а не проверять текст в исходнике. Урок [render-guards]:
 * проверка на упоминание проходит и у полностью выключенного экрана. */
export function MyVenueApplicationsView({ rows, failed }: { rows: VenueApplication[] | null; failed: boolean }) {
  if (failed) {
    return (
      <section className="library-submit-section">
        <h3>Мои заявки</h3>
        <p className="conversations-section__hint" role="status">
          Не удалось загрузить ваши заявки — это сбой связи, а не отсутствие заявок. Загляните позже.
        </p>
      </section>
    );
  }

  if (rows === null) return null;
  if (rows.length === 0) return null;

  return (
    <section className="library-submit-section">
      <h3>Мои заявки</h3>
      <ul className="library-page__list">
        {rows.map((app) => {
          const outcome = venueApplicationOutcome(app.status, app.moderatedAt);
          return (
            <li key={app.id} className="library-page__item">
              <strong>{app.name}</strong>
              <span className="conversations-section__hint">{app.address}</span>
              <span className="library-submit-section__status">{outcome.label}</span>
              <span className="conversations-section__hint">{outcome.detail}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
