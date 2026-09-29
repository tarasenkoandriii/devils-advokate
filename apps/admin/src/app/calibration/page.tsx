'use client';

// Полный аудит 2026-08-30 — статус калибровочного gate (§5.3). Backend и
// обёртка getCalibrationStatus() существовали, страницы не было: операторы
// не видели, проходит ли gate, а данные для него (confirm-outcome в TMA)
// до того же аудита не поступали вовсе.
//
// Пункт [uncalibrated-number] 2026-09-06 — два исправления на этом
// экране:
//
//  • ОПИСАНИЕ GATE БЫЛО НЕВЕРНЫМ. Стояло: «Gate проходит при score
//    ниже порога». Gate проходит при РАЗМЕРЕ ВЫБОРКИ не меньше порога
//    (`sampleSize >= threshold`, ТЗ §4.3: «30 предсказаний с известным
//    исходом»); Brier score не сравнивается ни с каким порогом нигде в
//    коде, и числового порога для него нет и в ТЗ. Поле «Порог: 30»
//    стояло вплотную к «Brier score: 0.675», и прочитать это можно
//    было только одним способом — неверным.
//  • БЕЙДЖ «НЕ ПРОЙДЕН» ПРИ ОДНОМ ИСХОДЕ. Условие показа было
//    `sampleSize > 0`, то есть при единственном отмеченном исходе
//    оператор видел красное «не пройден» — «измерили и не сошлось»
//    вместо «мерить пока не на чем». Порог решает, какая надпись
//    честна, поэтому сравнение теперь с порогом, а не с нулём.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getCalibrationStatus } from '../../lib/endpoints';
import type { CalibrationBucket, CalibrationStatus } from '../../lib/types';

const CONFIDENCE_LABEL: Record<CalibrationBucket['confidence'], string> = {
  LOW: 'низкая уверенность',
  MEDIUM: 'средняя уверенность',
  HIGH: 'высокая уверенность',
};

/** Почему у корзины нет числа. Разные причины пустоты читаются
 * по-разному, поэтому не сводятся к одному прочерку. */
function bucketNote(b: CalibrationBucket): string {
  if (b.calibrated) return `посчитано по ${b.sampleSize} подтверждённым исходам`;
  if (!b.datasetReady) return 'вся выборка меньше порога — числа нет ни у одной корзины';
  if (b.sampleSize === 0) return `исходов в этой корзине пока нет (нужно ${b.threshold})`;
  return `исходов ${b.sampleSize} из ${b.threshold}`;
}

export default function CalibrationPage() {
  const [data, setData] = useState<CalibrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getCalibrationStatus().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, []);
  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!data) return <div className="page"><p className="muted">Загрузка…</p></div>;
  const enough = data.sampleSize >= data.threshold && data.brierScore !== null;
  return (
    <div className="page">
      <h1>Калибровка прогнозов</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Brier score по сценариям исхода, которые пользователи отметили как «сбылось / не сбылось» в TMA. Gate
        проходит, когда подтверждённых исходов набралось не меньше порога — ниже порога сам score статистически
        ненадёжен для решения о промоуте промптов (см. <Link href="/prompts">Промпты</Link>). Числового порога для
        самого score в ТЗ нет: gate — про размер выборки, score — величина, на которую смотрит человек.
        Пересчёт — раз в сутки pg_cron (<code>internal/calibration/recompute</code>).
      </p>
      <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div><div className="muted">Подтверждённых исходов</div><strong>{data.sampleSize}</strong></div>
        <div><div className="muted">Brier score</div><strong>{data.brierScore === null ? '—' : data.brierScore.toFixed(3)}</strong></div>
        <div><div className="muted">Порог выборки</div><strong>{data.threshold}</strong></div>
        <div><div className="muted">Gate</div><strong>{!enough ? <span className="badge badge-pending">данных недостаточно</span> : data.gatePassed ? <span className="badge badge-ok">пройден</span> : <span className="badge badge-bad">не пройден</span>}</strong></div>
      </div>

      <h2 style={{ marginTop: 24 }}>По корзинам уверенности</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Эмпирическая точность (<code>calibratedProbability</code>) — величина корзины, не всей выборки. Тридцать
        исходов в одной корзине не означают, что измерены остальные, поэтому корзины перечислены все, включая
        пустые. Прочерк значит «ещё не откалибровано», а не «точность нулевая»; порог на корзину — {data.bucketThreshold}.
      </p>
      <div className="card">
        <table>
          <thead>
            <tr><th>Корзина</th><th>Эмпирическая точность</th><th>Выборка корзины</th></tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <tr key={b.confidence}>
                <td>{CONFIDENCE_LABEL[b.confidence]}</td>
                <td>
                  {b.calibratedProbability === null
                    ? <span className="badge badge-pending">не откалибровано</span>
                    : <strong>{b.calibratedProbability.toFixed(3)}</strong>}
                </td>
                <td className="muted">{bucketNote(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!enough && <p className="muted" style={{ marginTop: 16 }}>Данные появятся, когда пользователи начнут отмечать исходы сценариев в проектах. До полного аудита 2026-08-30 такой кнопки в TMA не было — счётчик честно начинается с нуля.</p>}
    </div>
  );
}
