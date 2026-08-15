'use client';

// Пункт: замена секции "Один цикл для кожної важливої розмови" на
// готовую профессиональную инфографику из внешнего пакета
// (layout.json + базовое изображение без текста + переводы по
// локалям). Координатная система пакета — canvas/SVG (текст
// позиционируется по базовой линии первой строки + anchor.x, не по
// верхнему углу бокса, как в обычном CSS) — поэтому рендер идёт
// через SVG <text>, не через position:absolute div'ы (как в
// предыдущей версии CycleSteps.tsx) — это единственный способ точно
// воспроизвести координаты пакета без пересчёта в другую систему.
//
// ПЕРЕНОС СТРОК — РЕАЛЬНОЕ ИЗМЕРЕНИЕ ШИРИНЫ, НЕ ПРИБЛИЖЕНИЕ. Пакет
// даёт "lines" только для исходного (русского) текста — переводы
// требуют собственной разбивки по словам. Первая версия использовала
// приближение (средняя ширина символа) — дало реальные наложения
// текста при рендере (проверено визуально, не предположение) даже
// при том, что переведённый текст укладывался в лимит maxChars:
// maxChars расчитан для ОДНОГО конкретного кегля/семейства шрифта,
// реальная ширина при рендере может отличаться. Здесь — точное
// измерение через canvas.measureText(), тот же приём, что уже
// использовался при подготовке переводов (см. wrap_measure.py в
// процессе разработки, не сохранён в репозитории — одноразовый
// скрипт проверки, не часть рантайма).
//
// 'use client' — canvas.measureText() требует document, недоступен
// при серверном рендере Next.js. Текст рендерится ПОСЛЕ монтирования
// (useEffect), с honest fallback — до готовности показывается только
// базовое изображение без текста (не пустой экран, не сломанная вёрстка).

import { useEffect, useRef, useState } from 'react';
import layoutData from '../lib/cycle-map/layout.json';
import ukStrings from '../lib/cycle-map/uk.json';
import ruStrings from '../lib/cycle-map/ru.json';
import enStrings from '../lib/cycle-map/en.json';
import type { Locale } from '../lib/i18n/config';

interface LayoutString {
  id: string;
  section: string;
  box: { x: number; y: number; w: number; h: number };
  anchor: { align: 'left' | 'center' | 'right'; x: number; baselineFirst: number };
  font: { family: string; size: number; lineHeight: number; weight: number; color: string };
  maxLines: number;
}

interface Layout {
  meta: { canvas: { width: number; height: number } };
  strings: LayoutString[];
}

const layout = layoutData as Layout;
const STRINGS_BY_LOCALE: Record<Locale, Record<string, string>> = {
  uk: ukStrings,
  ru: ruStrings,
  en: enStrings,
};

// Секции, лежащие поверх фотографий радиального цикла — нужна тень
// для читаемости независимо от того, что на фото под текстом (тот же
// принцип, что уже применялся в предыдущей версии секции).
function needsShadow(id: string): boolean {
  return id.startsWith('cycle.');
}

interface RenderedLine {
  text: string;
  x: number;
  y: number;
}

interface RenderedString extends LayoutString {
  renderLines: RenderedLine[];
}

export function CycleMap({ locale }: { locale: Locale }) {
  const [rendered, setRendered] = useState<RenderedString[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const strings = STRINGS_BY_LOCALE[locale] ?? STRINGS_BY_LOCALE.uk;

    function measure(text: string, family: string, size: number, weight: number): number {
      ctx!.font = `${weight} ${size}px ${family}`;
      return ctx!.measureText(text).width;
    }

    function wrap(text: string, s: LayoutString): string[] {
      const family = s.font.family;
      const words = text.split(' ');
      const lines: string[] = [];
      let cur = '';
      for (const w of words) {
        const trial = (cur + ' ' + w).trim();
        const width = measure(trial, family, s.font.size, s.font.weight);
        if (width <= s.box.w || !cur) {
          cur = trial;
        } else {
          lines.push(cur);
          cur = w;
        }
      }
      if (cur) lines.push(cur);
      return lines.slice(0, s.maxLines);
    }

    const result: RenderedString[] = [];
    for (const s of layout.strings) {
      const text = strings[s.id];
      if (!text) continue;
      const lines = wrap(text, s);
      const renderLines: RenderedLine[] = lines.map((line, i) => ({
        text: line,
        x: s.anchor.x,
        y: s.anchor.baselineFirst + i * s.font.lineHeight,
      }));
      result.push({ ...s, renderLines });
    }
    setRendered(result);
  }, [locale]);

  const { width, height } = layout.meta.canvas;
  const textAnchorFor = (align: string) => (align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start');

  return (
    <section className="section cycle-map-section">
      <div className="container">
        <div className="cycle-map">
          <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" role="img" aria-label="Devil's Advocate — карта можливостей">
            <image href="/images/cycle-map/base.png" x={0} y={0} width={width} height={height} />
            {rendered?.map((s) =>
              s.renderLines.map((line, i) => (
                <text
                  key={`${s.id}-${i}`}
                  x={line.x}
                  y={line.y}
                  textAnchor={textAnchorFor(s.anchor.align)}
                  fontFamily={s.font.family}
                  fontSize={s.font.size}
                  fontWeight={s.font.weight}
                  fill={s.font.color}
                  style={needsShadow(s.id) ? { filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.9))' } : undefined}
                >
                  {line.text}
                </text>
              )),
            )}
          </svg>
        </div>
      </div>
    </section>
  );
}
