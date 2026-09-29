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
// окна: сегодня/3 дня/неделя). Вторая метрика ТЗ ("сглаженных
// конфликтов") тогда была заблокирована непостроенным индикатором
// накала §3.33 — с Пунктом 85 она реально считается из
// EscalationCategoryEvent (см. DecisionOutcomeService.getSuccessStats),
// комментарий об этом устарел и исправлен аудитом 2026-09-03.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCalibrationSummary, getSuccessStats } from '../../lib/features';
import { CalibrationSummary, SuccessStats } from '../../lib/types';
import { SectionLoadError } from '../../components/SectionLoadError';
import { useBackButton } from '../../hooks/useBackButton';

/** Пункт [rate-on-one-case] 2026-09-06 — доля и утверждения о паттерне
 * показываются только там, где им есть на чём стоять.
 *
 * Условие показа было одно: `classifiable !== 0`. После ПЕРВОГО же
 * отмеченного исхода человек читал о себе «в 1 из 1 случаев (100%)» —
 * или «(0%)», если исход вышел плохим. Рядом печаталось «В 1 случаях
 * аргументы склоняли действовать, но исход оказался плохим — риск был
 * недооценён»: утверждение о ПАТТЕРНЕ его решений по одному случаю.
 *
 * Порог решает СЕРВЕР и присылает `rateShown`: экран не придумывает
 * правило сам, иначе оно разъехалось бы с порогом разбивки по
 * категориям — который в продукте был всё это время. */
function StatsBlock({ label, stats }: { label: string; stats: CalibrationSummary['overall'] }) {
  if (!stats.rateShown) {
    return (
      <div className="calibration-block">
        <p className="steelman-case__label">{label}</p>
        <p className="conversations-section__hint">
          {stats.classifiable === 0
            ? 'Пока недостаточно данных для сравнения (нужны решения со взвешенными аргументами и отмеченным исходом).'
            : `Сравнимых случаев пока ${stats.classifiable} из ${stats.minSample} нужных. Доля здесь не показана намеренно: по такому числу случаев она сказала бы о случайности, а не о ваших решениях.`}
        </p>
      </div>
    );
  }
  return (
    <div className="calibration-block">
      <p className="steelman-case__label">{label}</p>
      <p>
        Прогноз совпал с реальным исходом в {stats.matchCount} из {stats.classifiable} случаев ({Math.round((stats.matchRate ?? 0) * 100)}%).
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

  // Аудит 2026-09-03: при сбое загрузки страница показывала «Пока не
  // отмечено ни одного исхода решения» — утверждение о ПРОШЛОМ
  // пользователя, которого мы в этот момент не знаем. Хуже пустой
  // страницы: человек делает вывод о себе по нашей аварии.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void Promise.all([
      getCalibrationSummary().then(setSummary).catch(() => { setSummary(null); setFailed(true); }),
      getSuccessStats().then(setStats).catch(() => { setStats(null); setFailed(true); }),
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

      {failed ? (
        <SectionLoadError what="статистику калибровки" hint="вы не отмечали исходов решений" />
      ) : !summary || summary.totalRecorded === 0 ? (
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
