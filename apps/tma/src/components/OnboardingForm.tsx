'use client';

// Онбординг-данные (§3.24 ТЗ). Значение по умолчанию — "Не указывать"
// (пустая строка), выбрано изначально в <select>.
//
// Пункт 49: country + гео-подсказка добавлены по прямому, сознательному
// запросу пользователя, ОТМЕНЯЮЩЕМУ более раннее P0-решение против
// автоподсказки конфессии по стране (см. подробную историю решения в
// onboarding.service.ts и apps/api/prisma/README.md, «Пункт 49»).
// Смягчение риска, оставшееся от старого решения, соблюдено буквально
// здесь: подсказка НИКОГДА не заполняет поля формы автоматически —
// геолокация только по явному нажатию кнопки, предпросмотр подсказки
// показывается ОТДЕЛЬНО от формы, поля меняются только по отдельному
// явному "Использовать эту подсказку", "Не указывать" остаётся видимым
// лёгким вариантом на каждом шаге, не скрыт и не обойдён подсказкой.

import { useEffect, useState } from 'react';
import { getOnboarding, saveOnboarding, suggestOnboardingFromLocation } from '../lib/features';
import { LocationSuggestion } from '../lib/types';
import { haptic } from '../lib/telegram';
import { checkLocationConsent, LocationConsentPrompt } from './LocationConsentPrompt';
import { VoiceEnrollmentSection } from './VoiceEnrollmentSection';

const RELIGION_OPTIONS = [
  { value: '', label: 'Не указывать' },
  { value: 'Христианство', label: 'Христианство' },
  { value: 'Ислам', label: 'Ислам' },
  { value: 'Иудаизм', label: 'Иудаизм' },
  { value: 'Буддизм', label: 'Буддизм' },
  { value: 'Другое', label: 'Другое' },
];

export function OnboardingForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [religion, setReligion] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [countryCode, setCountryCode] = useState<string | null>(null);

  const [detecting, setDetecting] = useState(false);
  const [suggestion, setSuggestion] = useState<LocationSuggestion | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [showConsentPrompt, setShowConsentPrompt] = useState(false);

  useEffect(() => {
    getOnboarding()
      .then((data) => {
        setReligion(data.religion ?? '');
        setCity(data.city ?? '');
        setCountry(data.country ?? '');
      })
      .catch(() => {
        // Молча оставляем дефолты — отсутствие данных на сервере не
        // ошибка, это и есть состояние "не указано".
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveOnboarding({ religion: religion || null, city: city || null, country: country || null, countryCode });
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  // Пункт 77 (§3.32 ТЗ) — единый геозапрос, тот же гейт, что в
  // WeatherForecastSection.tsx/VenueRecommendationSection.tsx.
  async function handleDetectFromLocation() {
    const hasConsent = await checkLocationConsent();
    if (!hasConsent) {
      setShowConsentPrompt(true);
      return;
    }
    requestGeolocation();
  }

  function requestGeolocation() {
    if (!('geolocation' in navigator)) {
      setSuggestionError('Геолокация недоступна в этом браузере/приложении');
      return;
    }
    setDetecting(true);
    setSuggestionError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const result = await suggestOnboardingFromLocation(position.coords.latitude, position.coords.longitude);
          setSuggestion(result);
          haptic('success');
        } catch (err) {
          haptic('error');
          setSuggestionError(err instanceof Error ? err.message : 'Не удалось получить подсказку');
        } finally {
          setDetecting(false);
        }
      },
      () => {
        setDetecting(false);
        setSuggestionError('Доступ к геолокации не предоставлен');
      },
    );
  }

  // Заполняет поля формы ТОЛЬКО по этому явному действию — не
  // побочный эффект handleDetectFromLocation() выше.
  function handleUseSuggestion() {
    if (!suggestion) return;
    if (suggestion.country) setCountry(suggestion.country);
    setCountryCode(suggestion.countryCode ?? null);
    if (suggestion.city) setCity(suggestion.city);
    if (suggestion.suggestedReligion) {
      const matches = RELIGION_OPTIONS.some((opt) => opt.value === suggestion.suggestedReligion);
      setReligion(matches ? (suggestion.suggestedReligion as string) : 'Другое');
    }
    setSuggestion(null);
    haptic('success');
  }

  if (loading) return null;

  return (
    <section className="card-section">
      <h3>Личные данные</h3>

      <label className="onboarding-field">
        Страна
        <input type="text" value={country} onChange={(e) => { setCountry(e.target.value); setCountryCode(null); }} placeholder="Не указана" />
      </label>

      <label className="onboarding-field">
        Город
        <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Не указан" />
      </label>

      <label className="onboarding-field">
        Вероисповедание
        <select value={religion} onChange={(e) => setReligion(e.target.value)}>
          {RELIGION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="generation-error">{error}</p>}

      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? 'Сохраняем…' : 'Сохранить'}
      </button>

      <div className="onboarding-geo-suggestion">
        {showConsentPrompt ? (
          <LocationConsentPrompt
            source="onboarding"
            onGranted={() => {
              setShowConsentPrompt(false);
              requestGeolocation();
            }}
            onCancel={() => setShowConsentPrompt(false)}
          />
        ) : (
          <button type="button" onClick={handleDetectFromLocation} disabled={detecting}>
            {detecting ? 'Определяем…' : 'Определить по местоположению'}
          </button>
        )}
        {suggestionError && <p className="generation-error">{suggestionError}</p>}
        {suggestion && (
          <div className="onboarding-geo-suggestion__card">
            <p className="conversations-section__hint">
              🟡 Подсказка, не факт — примите или пропустите, поля формы пока НЕ изменены.
            </p>
            <p>Страна: {suggestion.country ?? '—'}, город: {suggestion.city ?? '—'}</p>
            {suggestion.suggestedReligion && (
              <p>
                Наиболее распространённая конфессия в этом регионе: {suggestion.suggestedReligion}
                {suggestion.reasoning && <span className="onboarding-geo-suggestion__reasoning"> ({suggestion.reasoning})</span>}
              </p>
            )}
            <div className="conversations-section__add-actions">
              <button type="button" onClick={handleUseSuggestion}>
                Использовать эту подсказку
              </button>
              <button type="button" onClick={() => setSuggestion(null)}>
                Пропустить
              </button>
            </div>
          </div>
        )}
      </div>

      <VoiceEnrollmentSection />
    </section>
  );
}
