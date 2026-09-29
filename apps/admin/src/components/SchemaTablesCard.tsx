'use client';

// Пункт [deploy-step-did-nothing] 2026-09-26 — карточка «Таблицы схемы».
//
// Отдельным компонентом, а не куском страницы: мутация «убрать число
// пропавших таблиц» пережила первую версию проверок, потому что экран
// админки не рисовала ни одна из них. Разметку надо РИСОВАТЬ — тот же
// вывод, что у `OperatorTraceNotice` и у раздела удаления аккаунта.

import type { DbStateSchemaTables, DbStateSection } from '../lib/types';

function isError<T>(section: DbStateSection<T>): section is { error: string } {
  return typeof section === 'object' && section !== null && 'error' in section;
}

export function SchemaTablesCard({ section }: { section: DbStateSection<DbStateSchemaTables> }) {
  if (isError(section)) {
    return (
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Таблицы схемы</h2>
        {/* «Не смогли посмотреть» и «расхождений нет» — разные ответы, и
            они здесь различаются, как и во всех секциях этой вкладки. */}
        <p role="alert">Не удалось сверить: {section.error}</p>
      </div>
    );
  }
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h2 style={{ marginTop: 0 }}>Таблицы схемы</h2>
      <p className="muted">
        Объявлено в схеме: {section.declaredCount}. Найдено в базе: {section.observedCount}.
      </p>
      {section.missingInDatabase.length > 0 ? (
        <>
          <p role="alert">
            <strong>
              Нет в базе: {section.missingInDatabase.length} из {section.declaredCount}
            </strong>{' '}
            — эти фичи не работают целиком.
          </p>
          <ul>
            {section.missingInDatabase.map((t) => (
              <li key={t.table}>
                <code>{t.table}</code> <span className="muted">(модель {t.model})</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Все объявленные таблицы в базе есть.</p>
      )}
      {section.unknownInSchema.length > 0 && (
        <>
          <p className="muted">Есть в базе, но схема о них не знает:</p>
          <ul>
            {section.unknownInSchema.map((t) => (
              <li key={t}>
                <code>{t}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Список того, чего сверка НЕ проверяет, стоит рядом с её
          результатом: иначе «все таблицы есть» читается как «база
          соответствует схеме». */}
      <details className="hint">
        <summary>Чего эта сверка не проверяет</summary>
        <ul>
          {section.notChecked.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
