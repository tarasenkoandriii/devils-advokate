'use client';

// Пункт 23 (backend) → TMA UI: Argument Lifecycle (§3.58 ТЗ).
//
// Раньше был серверным компонентом (без 'use client') — теперь нужен
// локальный state для смены статуса, стал клиентским.

import { useState } from 'react';
import {
  getArgumentFailureInsight,
  transitionArgumentLifecycle,
} from '../lib/features';
import { Argument, ArgumentFailureInsight, ArgumentLifecycleStatus } from '../lib/types';
import { haptic } from '../lib/telegram';

interface ArgumentsListProps {
  arguments: Argument[];
  projectId: string;
}

const STATUS_LABELS: Record<ArgumentLifecycleStatus, string> = {
  DRAFT: 'Черновик',
  TESTED: 'Проверен',
  USED: 'Использован',
  ACCEPTED: 'Принят',
  REJECTED: 'Отвергнут',
  COUNTERED: 'Опровергнут',
  EXPIRED: 'Устарел',
  VERIFIED: 'Подтверждён',
};

const STATUS_OPTIONS: ArgumentLifecycleStatus[] = [
  'DRAFT',
  'TESTED',
  'USED',
  'ACCEPTED',
  'REJECTED',
  'COUNTERED',
  'EXPIRED',
  'VERIFIED',
];

export function ArgumentsList({ arguments: args, projectId }: ArgumentsListProps) {
  const pros = args.filter((a) => a.stance === 'PRO').sort(byWeightDesc);
  const cons = args.filter((a) => a.stance === 'CON').sort(byWeightDesc);

  if (args.length === 0) {
    return null;
  }

  return (
    <div className="arguments-list">
      <div className="arguments-list__column arguments-list__column--pro">
        <h3>За</h3>
        <ul>
          {pros.map((a) => (
            <ArgumentItem key={a.id} argument={a} projectId={projectId} />
          ))}
        </ul>
      </div>
      <div className="arguments-list__column arguments-list__column--con">
        <h3>Против</h3>
        <ul>
          {cons.map((a) => (
            <ArgumentItem key={a.id} argument={a} projectId={projectId} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ArgumentItem({ argument, projectId }: { argument: Argument; projectId: string }) {
  const [status, setStatus] = useState(argument.lifecycleStatus);
  const [changing, setChanging] = useState(false);
  const [insight, setInsight] = useState<ArgumentFailureInsight | null>(null);

  async function handleStatusChange(newStatus: ArgumentLifecycleStatus) {
    if (newStatus === status) return;
    setChanging(true);
    try {
      await transitionArgumentLifecycle(projectId, argument.id, { toStatus: newStatus });
      setStatus(newStatus);
      haptic('success');
      // §3.58 ТЗ: "выводы вида «этот аргумент уже трижды не сработал»"
      // — проверяем именно при переходе В статус-провал (REJECTED/
      // COUNTERED), не на каждую смену статуса — иначе пользователь
      // видел бы бессмысленный запрос при каждом клике.
      if (newStatus === 'REJECTED' || newStatus === 'COUNTERED') {
        const result = await getArgumentFailureInsight(projectId, argument.id);
        setInsight(result);
      }
    } catch {
      haptic('error');
    } finally {
      setChanging(false);
    }
  }

  return (
    <li>
      <span>{argument.text}</span>
      {/* Тег происхождения (§3.10 ТЗ) — на этом проходе всё сгенерировано
       * через AIRouterService, поэтому единственное значение "догадка ИИ".
       * Когда появятся аргументы, производные от PersonFact, здесь
       * понадобится реальная логика выбора иконки по derivedFrom. */}
      <span className="arguments-list__source-tag" title="Догадка ИИ — не факт">
        🟡
      </span>
      {argument.weight !== null && (
        <span className="arguments-list__weight">{Math.round(argument.weight * 100)}%</span>
      )}
      <select
        className="arguments-list__lifecycle-select"
        value={status}
        disabled={changing}
        onChange={(e) => handleStatusChange(e.target.value as ArgumentLifecycleStatus)}
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {insight?.insight && <p className="arguments-list__failure-insight">{insight.insight}</p>}
    </li>
  );
}

function byWeightDesc(a: Argument, b: Argument): number {
  return (b.weight ?? 0) - (a.weight ?? 0);
}
