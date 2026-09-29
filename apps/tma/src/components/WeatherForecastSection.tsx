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
import { NotLoadedNotice } from './NotLoadedNotice';
import { LOCATION_PURPOSES } from '../lib/location-purposes';

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
  const [notLoaded, setNotLoaded] = useState(false);

  async function handleExpand() {
    setExpanded(true);
    if (forecasts !== null) return;
    try {
      const existing = await listWeatherForecasts(scheduledConversationId);
      setForecasts(existing);
      setNotLoaded(false);
    } catch {
      // [failure-looks-empty] 2026-09-05: то же, что в подборе мест —
      // «прогноза нет» и «прогноз не загрузился» выглядели одинаково.
      setForecasts([]);
      setNotLoaded(true);
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
    const hasConsent = await checkLocationConsent(LOCATION_PURPOSES.WEATHER);
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
      {/* Пункт [forecast-without-source] 2026-09-06: три правки в одном
          блоке. (1) Совет печатался всегда — в том числе когда сервис
          прогнозов ответил пустотой, и модель выдавала «проводить /
          перенести» по строке «нет данных». Теперь совета в этом случае
          нет вовсе, а вместо него сказано почему. (2) Описание погоды
          может отсутствовать при известной температуре — пусто здесь не
          значит «погода никакая». (3) Автор прогноза назван: сервисов
          два, и раньше человек читал число, не зная, чей он. */}
      {latest && (
        <div className={`weather-forecast-section__result${latest.recommendation ? ` weather-forecast-section__result--${latest.recommendation.toLowerCase()}` : ''}`}>
          <strong>
            {latest.condition ?? 'Описание погоды сервис не дал'}
            {latest.temperatureCelsius !== null && `, ${Math.round(latest.temperatureCelsius)}°C`}
          </strong>
          {latest.cityLabel && <span className="conversations-section__hint"> — {latest.cityLabel}</span>}
          {latest.recommendation ? (
            <p className="steelman-case__label">🟡 {latest.recommendation === 'PROCEED' ? 'Можно проводить как запланировано' : 'Возможно, стоит перенести'}</p>
          ) : (
            <p className="steelman-case__label">Совета нет — не из чего</p>
          )}
          <p>{latest.recommendationReason}</p>
          <p className="conversations-section__hint">
            {latest.source ? `Источник прогноза: ${latest.source === 'windy' ? 'Windy' : 'Open-Meteo'}` : 'Источник прогноза не записан — эта запись сделана до того, как продукт стал его сохранять'}
          </p>
        </div>
      )}

      {notLoaded && <NotLoadedNotice what="сохранённые прогнозы для этой встречи" />}
      {error && <p role="alert" className="generation-error">{error}</p>}
      {showConsentPrompt ? (
        <LocationConsentPrompt
          purposes={[LOCATION_PURPOSES.WEATHER]}
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
