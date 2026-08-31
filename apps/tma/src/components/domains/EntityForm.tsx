'use client';

// ТЗ §0 — универсальная форма по FieldSpec[]. Один компонент на все
// сущности/сессии/действия шести доменов.
import { useState } from 'react';
import { FieldSpec } from '../../lib/domains/types';
import { haptic } from '../../lib/telegram';

interface Props {
  fields: FieldSpec[];
  submitLabel: string;
  initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}

export function coerceValues(fields: FieldSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const f of fields) {
    const v = raw[f.name];
    if (v === '' || v === undefined || v === null) { delete out[f.name]; continue; }
    if (f.type === 'number' || f.type === 'money') out[f.name] = Number(v);
    else if (f.type === 'bool') out[f.name] = Boolean(v);
    else if (f.type === 'datetime' || f.type === 'date') out[f.name] = new Date(String(v)).toISOString();
  }
  return out;
}

async function fileToBase64(file: File): Promise<{ base64: string; contentType: string }> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), contentType: file.type || 'application/octet-stream' };
}

export function EntityForm({ fields, submitLabel, initial, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));

  async function submit() {
    for (const f of fields) {
      if (f.required && (values[f.name] === undefined || values[f.name] === '')) {
        setError(`Заполните поле «${f.label}»`);
        return;
      }
    }
    setBusy(true); setError(null);
    try {
      await onSubmit(coerceValues(fields, values));
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="entity-form">
      {fields.map((f) => (
        <label key={f.name} className="entity-form__field">
          <span>{f.label}{f.required ? ' *' : ''}</span>
          {f.type === 'textarea' && <textarea rows={3} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'select' && (
            <select value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">—</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.type === 'bool' && <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />}
          {(f.type === 'number' || f.type === 'money') && <input type="number" inputMode="decimal" value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'date' && <input type="date" value={String(values[f.name] ?? '').slice(0, 10)} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'datetime' && <input type="datetime-local" value={String(values[f.name] ?? '').slice(0, 16)} onChange={(e) => set(f.name, e.target.value)} />}
          {(f.type === 'text' || f.type === 'url') && <input type={f.type === 'url' ? 'url' : 'text'} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'file-base64' && (
            <input type="file" accept="image/*,video/*,application/pdf" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const { base64, contentType } = await fileToBase64(file);
              set(f.name, base64); set('contentType', contentType);
              if (file.type.startsWith('video/')) set('mediaType', 'VIDEO'); else if (file.type.startsWith('image/')) set('mediaType', 'PHOTO');
            }} />
          )}
          {f.hint && <small>{f.hint}</small>}
        </label>
      ))}
      {fields.some((f) => f.name === 'latitude') && fields.some((f) => f.name === 'longitude') && (
        <button type="button" className="secondary" onClick={() => {
          if (!('geolocation' in navigator)) { setError('Геолокация недоступна'); return; }
          navigator.geolocation.getCurrentPosition(
            (pos) => { set('latitude', pos.coords.latitude); set('longitude', pos.coords.longitude); },
            () => setError('Доступ к геолокации не предоставлен — координаты можно ввести вручную'),
          );
        }}>📍 Подставить координаты устройства</button>
      )}
      {error && <p className="generation-error">{error}</p>}
      <div className="entity-form__actions">
        <button type="button" className="primary" disabled={busy} onClick={submit}>{busy ? '…' : submitLabel}</button>
        {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Отмена</button>}
      </div>
    </div>
  );
}
