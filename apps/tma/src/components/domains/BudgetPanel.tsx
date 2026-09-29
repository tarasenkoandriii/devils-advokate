'use client';

// ТЗ §0 — BudgetPanel: строки + сводка по валютам. Backend отдаёт
// byCurrency[]; здесь суммы никогда не складываются между валютами.
//
// ПОПРАВКА, Пункт [budget-invented-a-currency] 2026-09-24. Строка выше
// говорила, что класс ошибок «суммирование, слепое к валюте», «учтён
// там» — на сервере. Он был учтён в ОДНОМ месте из четырёх: три домена
// группировали бюджет сами, отправляли строки без валюты в корзину со
// словом-заглушкой вместо валюты проекта и не приводили регистр.
// Утверждение о проверке, записанное внутри проверки, устарело молча —
// и именно оно мешало увидеть изъян. Теперь правило одно на все
// домены, а экран показывает «валюта не указана» словами.
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
      {error && <p role="alert" className="generation-error">{error}</p>}
      {byCurrency.length > 0 && (
        <div className="domain-budget__summary">
          {byCurrency.map((b) => (
            <div key={b.currency ?? ''} className="domain-budget__currency">
              <strong>{b.currency ?? 'валюта не указана'}</strong>
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
