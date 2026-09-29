'use client';

// Пункт [silent-destruction] 2026-09-04 — отчёт о необратимом действии.
//
// Слияние двух карточек одного кандидата удаляет вторую вместе с её
// листом (каскад в базе). Пункт, которому не нашлось пары в оставляемом
// листе, исчезал вместе со всеми позициями — НАВСЕГДА И МОЛЧА: в сервисе
// стоял `continue` без счётчика, а экран выбрасывал результат вызова
// целиком и показывал человеку только вибрацию телефона.
//
// Это не потеря находки модели, как в прежних заходах, — это работа
// человека: позиции, которые он сам записал о кандидате из второго
// источника. Поэтому и показывается не число, а ТЕКСТЫ пунктов: по своим
// же формулировкам он поймёт, чего лишился (тот же принцип, что в пункте
// [own-input] — где слова его, число менее честно, чем текст).
//
// Отдельным компонентом — чтобы отчёт можно было НАРИСОВАТЬ в тесте
// (урок [render-guards]): внутри большой панели с формами и запросами
// проверить его было бы нечем, кроме чтения исходника.

export type MergeOutcome = {
  positionsMoved?: number;
  clausesWithoutMatch?: number;
  positionsDropped?: number;
  droppedClauseTexts?: string[];
  frame?: string;
};

export function MergeReport({ outcome }: { outcome: MergeOutcome | null }) {
  if (!outcome || typeof outcome.positionsMoved !== 'number') return null;
  const withoutMatch = outcome.clausesWithoutMatch ?? 0;
  const shown = outcome.droppedClauseTexts ?? [];
  return (
    <div className="dtp-card">
      <div className="dtp-card__head dtp-card__head--static">
        <span>Что перенесено при слиянии</span>
      </div>
      <div className="dtp-card__body">
        {outcome.frame && <p className="dtp-status dtp-status--warn">{outcome.frame}</p>}
        <p>Перенесено позиций: {outcome.positionsMoved}.</p>
        {withoutMatch > 0 ? (
          <>
            <p className="dtp-status dtp-status--warn" role="status">
              Пунктов без пары в оставленном листе: {withoutMatch}; вместе с ними не перенеслось позиций: {outcome.positionsDropped ?? 0}. Присоединённая карточка удалена — вернуть их нельзя.
            </p>
            {shown.length > 0 && (
              <>
                <h4>Что не перенеслось</h4>
                <ul>{shown.map((t) => <li key={t}>{t}</li>)}</ul>
                {/* Усечён только ПОКАЗ примеров, и об усечении сказано:
                    само число потерянных названо точно выше. */}
                {withoutMatch > shown.length && (
                  <p className="dtp-muted">…и ещё {withoutMatch - shown.length} — здесь показаны первые {shown.length}.</p>
                )}
              </>
            )}
          </>
        ) : (
          <p className="dtp-muted">Все пункты присоединённого листа нашли пару — ничего не потеряно.</p>
        )}
      </div>
    </div>
  );
}
