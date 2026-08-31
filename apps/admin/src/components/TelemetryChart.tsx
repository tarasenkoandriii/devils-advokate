'use client';

// Пункт [admin-panel]: намеренно без внешней charting-библиотеки —
// один простой bar chart на плоских div'ах для соло-масштаба проекта
// (тот же принцип "не строить инфраструктуру под нагрузку, которой
// нет", что уже применён в TelemetryService на backend).

export interface TelemetryChartBar {
  label: string;
  value: number;
  colorVar?: string; // CSS custom property, например '--signal-critical'
}

export function TelemetryChart({ bars, unit }: { bars: TelemetryChartBar[]; unit?: string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {bars.map((bar) => (
        <div key={bar.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 140, fontSize: 12 }} className="muted" title={bar.label}>
            {bar.label}
          </div>
          <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 4, height: 18, overflow: 'hidden' }}>
            <div
              style={{
                width: `${(bar.value / max) * 100}%`,
                height: '100%',
                background: bar.colorVar ? `var(${bar.colorVar})` : 'var(--signal-calm)',
                minWidth: bar.value > 0 ? 2 : 0,
              }}
            />
          </div>
          <div style={{ width: 70, fontSize: 12, textAlign: 'right' }}>
            {bar.value}
            {unit ?? ''}
          </div>
        </div>
      ))}
    </div>
  );
}
