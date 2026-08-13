'use client';

// Пункт 66 (backend) → TMA UI: подача заявки владельцем заведения
// (§3.23 ТЗ). Отдельная страница, не привязана к конкретному проекту
// — владелец заведения не обязательно связан с каким-то одним
// решением пользователя.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getVenueAutofillData,
  searchVenueCandidates,
  submitVenueApplication,
} from '../../../lib/features';
import { PlaceSearchCandidate, VenueAutofillData } from '../../../lib/types';
import { useBackButton } from '../../../hooks/useBackButton';
import { haptic } from '../../../lib/telegram';

export default function VenueApplyPage() {
  const router = useRouter();
  useBackButton(() => router.push('/'));

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<PlaceSearchCandidate[] | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

  const [form, setForm] = useState<VenueAutofillData>({ name: '', address: '', phone: null, openingHours: [], photoReferences: [] });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const results = await searchVenueCandidates(query.trim());
      setCandidates(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось найти заведения');
    } finally {
      setSearching(false);
    }
  }

  async function handleSelectCandidate(candidate: PlaceSearchCandidate) {
    setSelectedPlaceId(candidate.placeId);
    try {
      const autofill = await getVenueAutofillData(candidate.placeId);
      setForm(autofill);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подгрузить данные заведения');
    }
  }

  function handleManualEntry() {
    setSelectedPlaceId(null);
    setCandidates(null);
    setForm({ name: query, address: '', phone: null, openingHours: [], photoReferences: [] });
  }

  async function handleSubmit() {
    if (!form.name.trim() || !form.address.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitVenueApplication({
        name: form.name.trim(),
        address: form.address.trim(),
        phone: form.phone ?? undefined,
        openingHours: form.openingHours,
        googlePlaceId: selectedPlaceId ?? undefined,
        photoReferences: form.photoReferences,
      });
      setSubmitted(true);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось отправить заявку');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="page">
        <h2>Заявка отправлена</h2>
        <p className="conversations-section__hint">Заявка проходит модерацию — появится в каталоге после одобрения.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h2>Добавить заведение</h2>
      <p className="conversations-section__hint">
        Найдите своё заведение через поиск — данные (адрес, телефон, часы работы) подгрузятся автоматически, вы
        сможете их поправить перед отправкой на модерацию.
      </p>

      {!candidates && (
        <div className="conversations-section__add">
          <label>
            Название заведения
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Например: Кафе Тихое" />
          </label>
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleSearch} disabled={searching || !query.trim()}>
              {searching ? 'Ищем…' : 'Найти'}
            </button>
            <button type="button" onClick={handleManualEntry}>
              Заполнить вручную
            </button>
          </div>
        </div>
      )}

      {candidates && !selectedPlaceId && (
        <ul className="venue-apply-page__candidates">
          {candidates.map((c) => (
            <li key={c.placeId}>
              <button type="button" onClick={() => handleSelectCandidate(c)}>
                {c.name} {c.rating !== null && `— ${c.rating.toFixed(1)}★`}
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={handleManualEntry}>
              Не нашли — заполнить вручную
            </button>
          </li>
        </ul>
      )}

      {(selectedPlaceId !== null || (candidates === null && form.name)) && (
        <div className="conversations-section__add">
          <label>
            Название
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Адрес
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <label>
            Телефон
            <input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value || null })} />
          </label>
          {error && <p className="generation-error">{error}</p>}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleSubmit} disabled={submitting || !form.name.trim() || !form.address.trim()}>
              {submitting ? 'Отправляем…' : 'Отправить на модерацию'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
