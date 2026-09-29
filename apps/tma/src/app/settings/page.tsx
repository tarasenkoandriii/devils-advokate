'use client';

// Пункт 64 (TMA UI): Настройки пользователя — переключатели "всегда
// показывать цитату/анекдот" (§3.25 ТЗ, пункт 44 общего списка).
// Первая страница настроек пользователя в проекте вообще — отдельная
// user-level страница, тот же паттерн, что /calibration и /privacy.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getOnboarding,
  listConsents,
  hasConsent,
  revokeConsent,
  updateSituationalContentPreferences,
  updateReligiousReminderFrequency,
} from '../../lib/features';
import { ReligiousReminderFrequency } from '../../lib/types';
import { useBackButton } from '../../hooks/useBackButton';
import { haptic } from '../../lib/telegram';
import { reportFailure } from '../../lib/failure-report';

// Пункт [promised-arrival] 2026-09-05: «Раз в день» читается как «раз в
// день оно придёт». Не придёт: показ происходит, только когда человек
// сам открывает приложение. Частота — это ПОТОЛОК показов, а не
// расписание доставки.
const FREQUENCY_OPTIONS: { value: ReligiousReminderFrequency; label: string }[] = [
  { value: 'EVERY_LAUNCH', label: 'При каждом входе' },
  { value: 'ONCE_PER_DAY', label: 'Не чаще раза в день' },
  { value: 'OFF', label: 'Выключено' },
];

export default function SettingsPage() {
  const router = useRouter();
  const [religionSet, setReligionSet] = useState(false);
  const [alwaysShowQuote, setAlwaysShowQuote] = useState(false);
  const [alwaysShowAnecdote, setAlwaysShowAnecdote] = useState(false);
  const [reminderFrequency, setReminderFrequency] = useState<ReligiousReminderFrequency>('ONCE_PER_DAY');
  const [locationGranted, setLocationGranted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useBackButton(() => router.push('/'));

  useEffect(() => {
    Promise.all([
      getOnboarding().then((data) => {
        setReligionSet(!!data.religion);
        setAlwaysShowQuote(data.alwaysShowQuote);
        setAlwaysShowAnecdote(data.alwaysShowAnecdote);
        setReminderFrequency(data.religiousReminderFrequency);
      }),
      listConsents().then((consents) => setLocationGranted(hasConsent(consents, 'LOCATION'))),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleToggleQuote() {
    const next = !alwaysShowQuote;
    setAlwaysShowQuote(next);
    setSaving(true);
    try {
      await updateSituationalContentPreferences({ alwaysShowQuote: next });
      haptic('light');
    } catch (err) {
      // Пункт [one-buzz-was-the-whole-answer] 2026-09-24: переключатель
      // отщёлкивал обратно, и это было ЕДИНСТВЕННЫМ объяснением —
      // человек видит, что настройка не применилась, и не знает почему.
      setAlwaysShowQuote(!next);
      reportFailure(err, 'Не удалось сохранить настройку');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleAnecdote() {
    const next = !alwaysShowAnecdote;
    setAlwaysShowAnecdote(next);
    setSaving(true);
    try {
      await updateSituationalContentPreferences({ alwaysShowAnecdote: next });
      haptic('light');
    } catch (err) {
      setAlwaysShowAnecdote(!next);
      reportFailure(err, 'Не удалось сохранить настройку');
    } finally {
      setSaving(false);
    }
  }

  async function handleFrequencyChange(next: ReligiousReminderFrequency) {
    const previous = reminderFrequency;
    setReminderFrequency(next);
    setSaving(true);
    try {
      await updateReligiousReminderFrequency(next);
      haptic('light');
    } catch (err) {
      setReminderFrequency(previous);
      reportFailure(err, 'Не удалось сохранить частоту напоминаний');
    } finally {
      setSaving(false);
    }
  }

  // Пункт 77 (§3.32 ТЗ) — "разрешение отзываемо в любой момент из
  // настроек — отзыв немедленно отключает все три сценария
  // использования" (buкально ТЗ). ConsentService.revoke() уже
  // реализует именно это — отзывает ВСЕ purposes разом, одна запись.
  async function handleRevokeLocation() {
    setSaving(true);
    try {
      await revokeConsent('LOCATION');
      setLocationGranted(false);
      haptic('light');
    } catch (err) {
      // Отзыв согласия, о провале которого сказали вибрацией: человек
      // уходит уверенным, что отозвал, — а согласие осталось.
      reportFailure(err, 'Не удалось отозвать согласие на геолокацию');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <main className="page">
      <h2>Настройки</h2>

      {/* Пункт 77 (§3.32 ТЗ) — не зависит от religionSet, показывается всегда. */}
      <div className="settings-page__section">
        <p className="steelman-case__label">Геолокация</p>
        {locationGranted ? (
          <>
            <p className="conversations-section__hint">
              Разрешено: подсказка города при онбординге, прогноз погоды для встреч, поиск заведений рядом.
            </p>
            <button type="button" onClick={handleRevokeLocation} disabled={saving}>
              Отозвать разрешение
            </button>
          </>
        ) : (
          <p className="conversations-section__hint">Геолокация не разрешена — будет запрошена при первом использовании.</p>
        )}
      </div>

      {!religionSet ? (
        <p className="conversations-section__hint">
          Цитаты и анекдоты по ситуации доступны после того, как вы укажете вероисповедание в анкете при первом
          входе.
        </p>
      ) : (
        <>
          <div className="settings-page__section">
            <p className="steelman-case__label">Разрядка в карточке проекта</p>
            <label className="settings-page__toggle">
              <input type="checkbox" checked={alwaysShowQuote} onChange={handleToggleQuote} disabled={saving} />
              Всегда показывать релевантную цитату при открытии проекта
            </label>
            <label className="settings-page__toggle">
              <input type="checkbox" checked={alwaysShowAnecdote} onChange={handleToggleAnecdote} disabled={saving} />
              Всегда показывать анекдот при открытии проекта
            </label>
          </div>

          <div className="settings-page__section">
            {/* Пункт [promised-arrival] 2026-09-05. Здесь стояло
                «Ежедневное напоминание о заповедях/столпах веры».
                Напоминание — это то, что приходит само; push-доставки у
                этой функции нет вовсе, показ происходит при открытии
                приложения. Человек, поставивший «раз в день» и не
                зашедший, не получал ничего и не знал почему. */}
            <p className="steelman-case__label">Заповеди/столпы веры при открытии приложения</p>
            <p className="conversations-section__hint">
              Показывается, когда вы сами открываете приложение. Это не уведомление: если не зайти, ничего не придёт.
            </p>
            <select
              value={reminderFrequency}
              onChange={(e) => handleFrequencyChange(e.target.value as ReligiousReminderFrequency)}
              disabled={saving}
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </main>
  );
}
