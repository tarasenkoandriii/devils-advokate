'use client';

// Пункт 65 (backend) → TMA UI: рекомендации заведений для встречи
// (§3.22 ТЗ, честно суженный объём — без монетизации и без
// автоматического бронирования, см. /TODO.md). Намеренно маленький
// изолированный компонент, принимающий scheduledConversationId —
// вставляется в SchedulerSection.tsx без правок его основной логики.

import { useState } from 'react';
import { generateVenueRecommendations, listVenueRecommendations } from '../lib/features';
import { VenueRecommendation } from '../lib/types';
import { haptic } from '../lib/telegram';
import { checkLocationConsent, LocationConsentPrompt } from './LocationConsentPrompt';

interface VenueRecommendationSectionProps {
  scheduledConversationId: string;
}

export function VenueRecommendationSection({ scheduledConversationId }: VenueRecommendationSectionProps) {
  const [venues, setVenues] = useState<VenueRecommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConsentPrompt, setShowConsentPrompt] = useState(false);

  async function handleExpand() {
    setExpanded(true);
    if (venues !== null) return;
    try {
      const existing = await listVenueRecommendations(scheduledConversationId);
      setVenues(existing);
    } catch {
      setVenues([]);
    }
  }

  // Пункт 77 (§3.32 ТЗ) — единый геозапрос, тот же гейт, что в
  // WeatherForecastSection.tsx.
  async function handleFindVenues() {
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
          const found = await generateVenueRecommendations(
            scheduledConversationId,
            position.coords.latitude,
            position.coords.longitude,
          );
          setVenues(found);
          haptic('success');
        } catch (err) {
          haptic('error');
          setError(err instanceof Error ? err.message : 'Не удалось подобрать заведения');
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
        Место для встречи
      </button>
    );
  }

  return (
    <div className="venue-recommendation-section">
      {venues && venues.length > 0 && (
        <ul className="venue-recommendation-section__list">
          {venues.map((v) => (
            <li key={v.id} className="venue-recommendation-section__item">
              <strong>{v.name}</strong>
              {v.rating !== null && <span> 🔵 {v.rating.toFixed(1)}★</span>}
              <span className="conversations-section__hint">{v.address}</span>
              {v.phone && <span className="conversations-section__hint">{v.phone}</span>}
              <span className="venue-recommendation-section__reason">🟡 {v.suitabilityReason}</span>
              {v.reviewSummary && <span className="venue-recommendation-section__reason">🟡 {v.reviewSummary}</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="generation-error">{error}</p>}
      {showConsentPrompt ? (
        <LocationConsentPrompt
          source="venue-recommendation"
          onGranted={() => {
            setShowConsentPrompt(false);
            requestGeolocation();
          }}
          onCancel={() => setShowConsentPrompt(false)}
        />
      ) : (
        <button type="button" onClick={handleFindVenues} disabled={loading}>
          {loading ? 'Подбираем…' : 'Подобрать место рядом'}
        </button>
      )}
    </div>
  );
}
