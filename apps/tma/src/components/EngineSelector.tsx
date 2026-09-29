'use client';

import { useEffect, useState } from 'react';
import { listEngines } from '../lib/features';
import { AvailableEngine } from '../lib/types';

interface EngineSelectorProps {
  value: string | undefined;
  onChange: (modelVersionId: string | undefined) => void;
}

export function EngineSelector({ value, onChange }: EngineSelectorProps) {
  const [engines, setEngines] = useState<AvailableEngine[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listEngines()
      .then((list) => { setEngines(list); setFailed(false); })
      // Аудит 2026-09-03: сбой прятал сам выбор движка — пользователь
      // молча уезжал на модель по умолчанию, считая, что выбора нет.
      // Это ровно «конфигурационный пробел выглядит как отсутствие
      // функции», от которого продукт отказывается в других местах.
      .catch(() => { setEngines([]); setFailed(true); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (failed) {
    return (
      <p className="conversations-section__hint">
        Список моделей не загрузился — запрос уйдёт на модель по умолчанию. Это сбой связи, а не «выбора нет».
      </p>
    );
  }
  if (engines.length === 0) return null;

  return (
    <label className="engine-selector">
      AI-движок
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">По умолчанию</option>
        {engines.map((engine) => (
          <option key={engine.modelVersionId} value={engine.modelVersionId}>
            {engine.providerName} — {engine.modelName}
          </option>
        ))}
      </select>
    </label>
  );
}
