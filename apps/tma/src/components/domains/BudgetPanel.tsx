'use client';

// ТЗ §0 — BudgetPanel: строки + сводка по валютам. Backend отдаёт
// byCurrency[] (bug class «currency-blind cost summation» учтён там);
// здесь суммы никогда не складываются между валютами.
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { ExtraPanelSpec } from '../../lib/domains/types';
import { EntityForm } from './EntityForm';
import { JsonView } from './JsonPanel';

export function BudgetPanel({ spec, configId }: { spec: ExtraPanelSpec; configId: string }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    domainApi.getJson(spec.route(configId)).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, [spec, configId, tick]);

  const byCurrency: any[] = data?.byCurrency ?? [];
  const lines: any[] = data?.lineItems ?? data?.items ?? [];

  return (
    <div className="domain-panel">
      {error && <p className="generation-error">{error}</p>}
      {byCurrency.length > 0 && (
        <div className="domain-budget__summary">
          {byCurrency.map((b) => (
            <div key={b.currency} className="domain-budget__currency">
              <strong>{b.currency}</strong>
              <span>расходы {b.totalExpense ?? 0}</span>
              <span>покрытие {b.totalCoverage ?? 0}</span>
              <span>итого {b.netBudget ?? (b.totalExpense ?? 0) - (b.totalCoverage ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      {lines.length > 0 ? <JsonView data={lines} /> : data && <p className="card-section__empty">Строк бюджета пока нет.</p>}
      {spec.budgetCreateRoute && spec.budgetFields && (adding ? (
        <EntityForm fields={spec.budgetFields} submitLabel="Добавить строку" onCancel={() => setAdding(false)}
          onSubmit={async (v) => { await domainApi.postJson(spec.budgetCreateRoute!(configId), v); setAdding(false); setTick((t) => t + 1); }} />
      ) : (
        <button type="button" className="primary" onClick={() => setAdding(true)}>+ Строка бюджета</button>
      ))}
    </div>
  );
}
