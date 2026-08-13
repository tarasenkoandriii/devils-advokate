'use client';

// Пункт 53 (TMA UI): Decision Track Record (§3.2 ТЗ), пункт 35
// v3-роадмапа. Отдельная user-level страница, не project-level секция
// (калибровка агрегирует по ВСЕМ проектам разом) — тот же паттерн
// отдельной страницы, что /privacy.
//
// РЕАЛЬНАЯ СТАТИСТИКА, НЕ AI-ДОГАДКА О ПСИХОЛОГИИ — подробное
// обоснование в apps/api/prisma/README.md, «Пункт 52». Здесь на
// уровне UI: числа показаны как есть (X из Y случаев), без ярлыков
// вроде "у вас есть когнитивное искажение" — формулировки нейтральные,
// описывают паттерн в решениях, не диагностируют человека.
//
// Пункт 73 (§3.34 ТЗ) добавил блок "Решено положительно" (скользящие
// окна: сегодня/3 дня/неделя) — честно только одна метрика из двух,
// описанных в ТЗ. Вторая метрика ("прекращённых/сглаженных
// конфликтов") заблокирована §3.33 — тем же непостроенным live-
// индикатором накала, что блокирует пункты 51/52/55/57 общего списка,
// см. /TODO.md.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCalibrationSummary, getSuccessStats } from '../../lib/features';
import { CalibrationSummary, SuccessStats } from '../../lib/types';
import { useBackButton } from '../../hooks/useBackButton';

function StatsBlock({ label, stats }: { label: string; stats: CalibrationSummary['overall'] }) {
  const classifiable = stats.matchCount + stats.overOptimisticCount + stats.overCautiousCount;
  if (classifiable === 0) {
    return (
      <div className="calibration-block">
        <p className="steelman-case__label">{label}</p>
        <p className="conversations-section__hint">Пока недостаточно данных для сравнения (нужны решения со взвешенными аргументами и отмеченным исходом).</p>
      </div>
    );
  }
  return (
    <div className="calibration-block">
      <p className="steelman-case__label">{label}</p>
      <p>
        Прогноз совпал с реальным исходом в {stats.matchCount} из {classifiable} случаев ({Math.round(stats.matchRate * 100)}%).
      </p>
      {stats.overOptimisticCount > 0 && (
        <p className="calibration-block__note">
          В {stats.overOptimisticCount} случаях аргументы склоняли действовать, но исход оказался плохим — риск был недооценён.
        </p>
      )}
      {stats.overCautiousCount > 0 && (
        <p className="calibration-block__note">
          В {stats.overCautiousCount} случаях аргументы склоняли не действовать, но исход оказался хорошим — риск был переоценён.
        </p>
      )}
    </div>
  );
}

export default function CalibrationPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<CalibrationSummary | null>(null);
  const [stats, setStats] = useState<SuccessStats | null>(null);
  const [loading, setLoading] = useState(true);

  useBackButton(() => router.push('/'));

  useEffect(() => {
    Promise.all([
      getCalibrationSummary().then(setSummary).catch(() => setSummary(null)),
      getSuccessStats().then(setStats).catch(() => setStats(null)),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  return (
    <main className="page">
      <h2>Калибровка решений</h2>

      {stats && (
        <div className="calibration-block">
          <p className="steelman-case__label">Решено положительно</p>
          <p className="conversations-section__hint">
            Сегодня: {stats.positiveOutcomesToday} · Последние 3 дня: {stats.positiveOutcomesLast3Days} · Неделя:{' '}
            {stats.positiveOutcomesLastWeek}
          </p>
        </div>
      )}

      {stats && (
        <div className="calibration-block">
          <p className="steelman-case__label">Сглаженные конфликты</p>
          <p className="conversations-section__hint">
            Разговоры, где накал вырос, но потом реально снизился — не оборвался на пике. Требует экрана
            сопровождения (§3.33).
          </p>
          <p className="conversations-section__hint">
            Сегодня: {stats.conflictsSmoothedToday} · Последние 3 дня: {stats.conflictsSmoothedLast3Days} · Неделя:{' '}
            {stats.conflictsSmoothedLastWeek}
          </p>
        </div>
      )}

      <p className="conversations-section__hint">
        Реальная статистика по вашим решениям — насколько прогноз (взвешенные аргументы) совпадал с тем, что случилось
        на самом деле. Отметить исход можно на странице конкретного проекта.
      </p>

      {!summary || summary.totalRecorded === 0 ? (
        <p className="conversations-section__hint">Пока не отмечено ни одного исхода решения.</p>
      ) : (
        <>
          <StatsBlock label="Общая картина" stats={summary.overall} />
          {summary.byCategory.map((cat) => (
            <StatsBlock key={cat.category} label={`Категория: ${cat.category}`} stats={cat} />
          ))}
        </>
      )}
    </main>
  );
}
