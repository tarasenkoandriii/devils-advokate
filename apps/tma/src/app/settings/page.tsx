'use client';

// Пункт 64 (TMA UI): Настройки пользователя — переключатели "всегда
// показывать цитату/анекдот" (§3.25 ТЗ, пункт 44 общего списка).
// Первая страница настроек пользователя в проекте вообще — отдельная
// user-level страница, тот же паттерн, что /calibration и /privacy.

import { useEffect, useState } from 'react';
import { NotLoadedNotice } from '../../components/NotLoadedNotice';
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

  // Пункт [settings-showed-defaults-as-yours] 2026-09-30 — здесь стоял
  // `.catch(() => {})` без причины, и последствия были такие.
  //
  // Экран рисовался на НАЧАЛЬНЫХ значениях состояния и выдавал их за
  // настройки человека:
  //
  //  1. «Геолокация не разрешена — будет запрошена при первом
  //     использовании» — утверждение о факте. И вместе с ним ИСЧЕЗАЛА
  //     кнопка «Отозвать разрешение»: она стоит в ветке
  //     `locationGranted`. Пункт 77/§3.32 обещает «разрешение отзываемо
  //     в любой момент из настроек» — при сбое одного GET отзывать
  //     оказывалось нечего, и экран утверждал, что нечего.
  //  2. Человеку, который вероисповедание указал, экран велел указать
  //     его «в анкете при первом входе» — то есть сделать то, что
  //     делается только при первом входе.
  //  3. Оба переключателя «Всегда показывать…» показывались
  //     выключенными независимо от реального значения.
  //
  // Две загрузки — два признака сбоя: подпись обязана стоять у той
  // настройки, которая не пришла, а не одна на весь экран. Тот же
  // образец, что в `PeopleSection` (Пункт [empty-looked-like-an-answer]).
  const [preferencesFailed, setPreferencesFailed] = useState(false);
  const [consentsFailed, setConsentsFailed] = useState(false);

  useEffect(() => {
    void Promise.all([
      getOnboarding()
        .then((data) => {
          setReligionSet(!!data.religion);
          setAlwaysShowQuote(data.alwaysShowQuote);
          setAlwaysShowAnecdote(data.alwaysShowAnecdote);
          setReminderFrequency(data.religiousReminderFrequency);
        })
        .catch(() => setPreferencesFailed(true)),
      listConsents()
        .then((consents) => setLocationGranted(hasConsent(consents, 'LOCATION')))
        .catch(() => setConsentsFailed(true)),
    ]).finally(() => setLoading(false));
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
        {consentsFailed ? (
          <NotLoadedNotice
            what="состояние согласия на геолокацию"
            consequence="Разрешено оно или нет — отсюда сейчас не видно, и отозвать его с этого экрана нельзя, пока связь не восстановится."
          />
        ) : locationGranted ? (
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

      {preferencesFailed ? (
        <NotLoadedNotice
          what="ваши настройки показа цитат и анекдотов"
          consequence="Переключатели ниже не показаны намеренно: выключенными они выглядели бы как ваш выбор."
        />
      ) : !religionSet ? (
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
