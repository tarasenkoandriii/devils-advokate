'use client';

// Пункт 51 (TMA UI): Scheduler (§3.20 ТЗ), доводит пункт 30
// v3-роадмапа до конца (backend был готов в Пункте 50, но по
// явно уточнённому объёму того запроса TMA UI не строился отдельно).
// Уровень проекта — тот же паттерн секции, что OutcomeScenariosSection.
//
// "Календарь: вид 'сегодня/завтра/послезавтра'... вид 'последняя
// неделя' — прошедшие с отметкой, был ли сделан постфактум-разбор"
// (буквально из ТЗ) — упрощено до двух групп (предстоящие/прошедшие),
// не полноценный визуальный календарь с сеткой дат — честное
// упрощение под мобильный экран, вся суть требования (какие
// разговоры впереди, какие прошли и есть ли для них разбор) сохранена.

import { useState, useEffect, useCallback } from 'react';
import {
  createScheduledConversation,
  linkScheduledConversation,
  listConversations,
  listPeople,
  listScheduledConversations,
  previewWeatherForScheduling,
} from '../lib/features';
import { Conversation, ProjectPersonLink, ScheduledConversation, WeatherForecastPreview } from '../lib/types';
import { haptic } from '../lib/telegram';
import { VenueRecommendationSection } from './VenueRecommendationSection';
import { WeatherForecastSection } from './WeatherForecastSection';
import { SchedulerAdviceSection } from './SchedulerAdviceSection';

interface SchedulerSectionProps {
  projectId: string;
}

const REMINDER_OPTIONS = [
  { value: '', label: 'Без напоминания о спарринге' },
  { value: '60', label: 'За час' },
  { value: '1440', label: 'За день' },
];

export function SchedulerSection({ projectId }: SchedulerSectionProps) {
  const [scheduled, setScheduled] = useState<ScheduledConversation[]>([]);
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const [scheduledAtInput, setScheduledAtInput] = useState('');
  const [personId, setPersonId] = useState('');
  const [reminderMinutes, setReminderMinutes] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weatherPreview, setWeatherPreview] = useState<WeatherForecastPreview | null>(null);

  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkChoice, setLinkChoice] = useState('');

  const reload = useCallback(() => {
    return listScheduledConversations(projectId)
      .then(setScheduled)
      .catch(() => setScheduled([]));
  }, [projectId]);

  useEffect(() => {
    void Promise.all([
      reload(),
      listPeople(projectId).then(setPeople).catch(() => setPeople([])),
      listConversations(projectId).then(setConversations).catch(() => setConversations([])),
    ]).finally(() => setLoading(false));
  }, [reload, projectId]);

  // Пункт 78 (§3.20 ТЗ) — "мягкое предупреждение прямо в форме
  // создания". Не блокирует создание — при любой ошибке или
  // отсутствии сохранённого профильного города просто ничего не
  // показывает, форма работает как обычно.
  useEffect(() => {
    if (!scheduledAtInput) {
      setWeatherPreview(null);
      return;
    }
    let cancelled = false;
    previewWeatherForScheduling(projectId, new Date(scheduledAtInput).toISOString())
      .then((result) => {
        if (!cancelled) setWeatherPreview(result);
      })
      .catch(() => {
        if (!cancelled) setWeatherPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, scheduledAtInput]);

  async function handleCreate() {
    if (!scheduledAtInput) return;
    setCreating(true);
    setError(null);
    try {
      await createScheduledConversation(projectId, {
        personId: personId || undefined,
        scheduledAt: new Date(scheduledAtInput).toISOString(),
        sparringReminderMinutesBefore: reminderMinutes ? Number(reminderMinutes) : null,
      });
      await reload();
      setScheduledAtInput('');
      setPersonId('');
      setReminderMinutes('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось запланировать разговор');
    } finally {
      setCreating(false);
    }
  }

  async function handleLink(scheduledId: string) {
    if (!linkChoice) return;
    try {
      await linkScheduledConversation(projectId, scheduledId, linkChoice);
      await reload();
      setLinkingId(null);
      setLinkChoice('');
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  if (loading) return null;

  const now = Date.now();
  const upcoming = scheduled.filter((s) => new Date(s.scheduledAt).getTime() >= now);
  const past = scheduled.filter((s) => new Date(s.scheduledAt).getTime() < now);

  return (
    <section className="scheduler-section">
      <h3>Планировщик разговоров</h3>

      <SchedulerAdviceSection projectId={projectId} />

      {upcoming.length > 0 && (
        <>
          <p className="steelman-case__label">Предстоящие</p>
          <ul className="scheduler-list">
            {upcoming.map((s) => (
              <li key={s.id} className="scheduler-list__item">
                <span>{new Date(s.scheduledAt).toLocaleString('ru-RU')}</span>
                {s.person && <span> — {s.person.displayName ?? 'Без имени'}</span>}
                {s.sparringReminderMinutesBefore && (
                  <span className="scheduler-list__note">
                    {s.sparringReminderSentAt ? '✓ напоминание о спарринге отправлено' : 'напоминание о спарринге запланировано'}
                  </span>
                )}
                <VenueRecommendationSection scheduledConversationId={s.id} />
                <WeatherForecastSection scheduledConversationId={s.id} />
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <p className="steelman-case__label">Прошедшие (последняя неделя и ранее)</p>
          <ul className="scheduler-list">
            {past.map((s) => (
              <li key={s.id} className="scheduler-list__item">
                <span>{new Date(s.scheduledAt).toLocaleString('ru-RU')}</span>
                {s.person && <span> — {s.person.displayName ?? 'Без имени'}</span>}
                {s.linkedConversation ? (
                  <span className="scheduler-list__note">✓ постфактум-разбор связан с разговором</span>
                ) : (
                  <div className="scheduler-list__link">
                    <span className="scheduler-list__note">Постфактум-разбор пока не связан ни с одним разговором</span>
                    {linkingId === s.id ? (
                      <div className="conversations-section__add-actions">
                        <select value={linkChoice} onChange={(e) => setLinkChoice(e.target.value)}>
                          <option value="">Выберите разговор</option>
                          {conversations.map((c) => (
                            <option key={c.id} value={c.id}>
                              {new Date(c.occurredAt).toLocaleDateString('ru-RU')}
                            </option>
                          ))}
                        </select>
                        <button type="button" onClick={() => handleLink(s.id)} disabled={!linkChoice}>
                          Связать
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setLinkingId(s.id)}>
                        Связать с разговором
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="conversations-section__add">
        <label>
          Дата и время
          <input type="datetime-local" value={scheduledAtInput} onChange={(e) => setScheduledAtInput(e.target.value)} />
        </label>
        {weatherPreview && weatherPreview.recommendation === 'RECONSIDER' && (
          <p className="scheduler-weather-warning">
            🟡 На эту дату в {weatherPreview.cityLabel} — {weatherPreview.condition}
            {weatherPreview.temperatureCelsius !== null && `, ${Math.round(weatherPreview.temperatureCelsius)}°C`}.{' '}
            {weatherPreview.recommendationReason}
          </p>
        )}
        {people.length > 0 && (
          <label>
            С кем (необязательно)
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">Не указано</option>
              {people.map((p) => (
                <option key={p.personId} value={p.personId}>
                  {p.person.displayName ?? 'Без имени'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Напоминание о подготовке
          <select value={reminderMinutes} onChange={(e) => setReminderMinutes(e.target.value)}>
            {REMINDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleCreate} disabled={creating || !scheduledAtInput}>
            {creating ? 'Планируем…' : 'Запланировать разговор'}
          </button>
        </div>
      </div>
    </section>
  );
}
