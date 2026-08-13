'use client';

// Пункт 66 (backend) → TMA UI: публичная карточка одобренного
// заведения (§3.23 ТЗ) — фото/контакты/часы работы/рейтинг. Тот же
// принцип, что /venues/page.tsx — обычный веб-роут без Telegram-
// контекста.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApprovedVenue } from '../../../lib/public-api';
import { confirmVenueBooking } from '../../../lib/features';
import { ApprovedVenue } from '../../../lib/types';
import { isTelegramWebAppAvailable, haptic } from '../../../lib/telegram';

export default function VenueDetailPage() {
  const params = useParams();
  const id = typeof params.id === 'string' ? params.id : '';

  const [venue, setVenue] = useState<ApprovedVenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!id) return;
    getApprovedVenue(id)
      .then(setVenue)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleConfirmBooking() {
    setConfirming(true);
    try {
      await confirmVenueBooking(id);
      setConfirmed(true);
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setConfirming(false);
    }
  }

  if (loading) return null;
  if (notFound || !venue) {
    return (
      <main className="page">
        <h2>Заведение не найдено</h2>
      </main>
    );
  }

  return (
    <main className="page library-entry-page">
      <h2>{venue.name}</h2>
      {venue.isPriorityPartner && <p className="venues-page__ad-label">Реклама</p>}
      {venue.rating !== null && <p className="conversations-section__hint">Рейтинг: {venue.rating.toFixed(1)}★</p>}
      <p className="conversations-section__hint">{venue.address}</p>
      {venue.phone && <p className="conversations-section__hint">{venue.phone}</p>}

      {venue.openingHours.length > 0 && (
        <>
          <p className="steelman-case__label">Часы работы</p>
          <ul>
            {venue.openingHours.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </>
      )}

      {/* "Комиссия за бронь, сделанную через сервис" (§3.22 ТЗ) —
          подтверждение требует реального пользователя (Telegram-
          аутентификация), недоступно при просмотре в обычном браузере
          без Telegram — та же логика, что уже применялась к
          дисклеймерам согласия по всему проекту. */}
      {isTelegramWebAppAvailable() && (
        <div className="conversations-section__add">
          {confirmed ? (
            <p className="conversations-section__hint">✓ Бронирование отмечено.</p>
          ) : (
            <button type="button" onClick={handleConfirmBooking} disabled={confirming}>
              {confirming ? 'Отмечаем…' : 'Я забронировал(а) это место'}
            </button>
          )}
        </div>
      )}
    </main>
  );
}
