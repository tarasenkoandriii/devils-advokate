'use client';

// Пункт 76 (backend) → TMA UI: виджет погоды и рекомендация о
// переносе разговора (§3.21 ТЗ). Тот же паттерн, что
// VenueRecommendationSection.tsx (Пункт 65) — раскрывается по клику,
// не занимает место на карточке встречи по умолчанию.
//
// Два способа запроса — buкально ТЗ: ручной ввод города (без
// согласия) или разовая геолокация устройства (требует явного
// opt-in, тот же паттерн getUserMedia-стиля запроса согласия, что
// уже применяется в VenueRecommendationSection.tsx).

import { useState } from 'react';
import { generateWeatherByCity, generateWeatherByGeolocation, listWeatherForecasts } from '../lib/features';
import { WeatherForecast } from '../lib/types';
import { haptic } from '../lib/telegram';
import { checkLocationConsent, LocationConsentPrompt } from './LocationConsentPrompt';

interface WeatherForecastSectionProps {
  scheduledConversationId: string;
}

export function WeatherForecastSection({ scheduledConversationId }: WeatherForecastSectionProps) {
  const [forecasts, setForecasts] = useState<WeatherForecast[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [cityInput, setCityInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConsentPrompt, setShowConsentPrompt] = useState(false);

  async function handleExpand() {
    setExpanded(true);
    if (forecasts !== null) return;
    try {
      const existing = await listWeatherForecasts(scheduledConversationId);
      setForecasts(existing);
    } catch {
      setForecasts([]);
    }
  }

  async function handleByCity() {
    if (!cityInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const forecast = await generateWeatherByCity(scheduledConversationId, cityInput.trim());
      setForecasts((prev) => [forecast, ...(prev ?? [])]);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось получить прогноз');
    } finally {
      setLoading(false);
    }
  }

  // Пункт 77 (§3.32 ТЗ) — единый геозапрос: перед вызовом
  // navigator.geolocation сначала проверяем согласие, показываем
  // общий экран объяснения, если ещё не дано.
  async function handleByGeolocation() {
    const hasConsent = await checkLocationConsent();
    if (!hasConsent) {
      setShowConsentPrompt(true);
      return;
    }
    requestGeolocation();
  }

  function requestGeolocation() {
    if (!('geolocation' in navigator)) {
      setError('Геолокация недоступна в этом браузере/приложении');
      return;
    }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const forecast = await generateWeatherByGeolocation(
            scheduledConversationId,
            position.coords.latitude,
            position.coords.longitude,
          );
          setForecasts((prev) => [forecast, ...(prev ?? [])]);
          haptic('success');
        } catch (err) {
          haptic('error');
          setError(err instanceof Error ? err.message : 'Не удалось получить прогноз');
        } finally {
          setLoading(false);
        }
      },
      () => {
        setLoading(false);
        setError('Доступ к геолокации не предоставлен');
      },
    );
  }

  if (!expanded) {
    return (
      <button type="button" onClick={handleExpand}>
        🌤 Погода на дату встречи
      </button>
    );
  }

  const latest = forecasts && forecasts.length > 0 ? forecasts[0] : null;

  return (
    <div className="weather-forecast-section">
      {latest && (
        <div className={`weather-forecast-section__result weather-forecast-section__result--${latest.recommendation.toLowerCase()}`}>
          <strong>
            {latest.condition}
            {latest.temperatureCelsius !== null && `, ${Math.round(latest.temperatureCelsius)}°C`}
          </strong>
          {latest.cityLabel && <span className="conversations-section__hint"> — {latest.cityLabel}</span>}
          <p className="steelman-case__label">🟡 {latest.recommendation === 'PROCEED' ? 'Можно проводить как запланировано' : 'Возможно, стоит перенести'}</p>
          <p>{latest.recommendationReason}</p>
        </div>
      )}

      {error && <p className="generation-error">{error}</p>}
      {showConsentPrompt ? (
        <LocationConsentPrompt
          source="weather-forecast"
          onGranted={() => {
            setShowConsentPrompt(false);
            requestGeolocation();
          }}
          onCancel={() => setShowConsentPrompt(false)}
        />
      ) : (
        <div className="conversations-section__add">
          <input value={cityInput} onChange={(e) => setCityInput(e.target.value)} placeholder="Название города" />
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleByCity} disabled={loading || !cityInput.trim()}>
              {loading ? 'Запрашиваем…' : 'По городу'}
            </button>
            <button type="button" onClick={handleByGeolocation} disabled={loading}>
              По моей геолокации
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
