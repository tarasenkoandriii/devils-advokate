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

  useEffect(() => {
    listEngines()
      .then(setEngines)
      .catch(() => setEngines([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading || engines.length === 0) {
    return null;
  }

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
