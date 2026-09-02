'use client';

// Пункт 14 (backend) → TMA UI: Commitment Tracker (§3.49 ТЗ).
//
// Показывает обязательства ПО ПРОЕКТУ (listCommitmentsByProject) — та
// же страница проекта, что ConversationsSection/PeopleSection.
// "Хронология по фигуранту" (listCommitmentsByPerson — обязательства
// этого человека сразу по ВСЕМ проектам) — бэкенд её уже поддерживает,
// но в TMA сейчас нет отдельной detail-страницы персоны, куда такой
// список мог бы лечь осмысленно (PeopleSection — просто список имён +
// кнопка Steelman на странице проекта, не отдельная страница). Честно
// не реализовано на этом проходе, не притворяемся.
//
// Извлечение обязательств ИЗ РАЗГОВОРА (постфактум-разбор, §2 ТЗ) —
// тоже не реализовано: это отдельная AI-задача (найти в транскрипте
// явные обещания) поверх уже существующего AIRouterService, требует
// своего промпта/taskType — не входит в этот проход, добавление
// обязательств здесь только вручную.

import { useState, useEffect, useCallback } from 'react';
import { createCommitment, listCommitmentsByProject, listPeople, updateCommitment } from '../lib/features';
import { Commitment, CommitmentOwner, ProjectPersonLink } from '../lib/types';
import { haptic } from '../lib/telegram';

interface CommitmentsSectionProps {
  projectId: string;
}

export function CommitmentsSection({ projectId }: CommitmentsSectionProps) {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const reload = useCallback(() => {
    return listCommitmentsByProject(projectId)
      .then(setCommitments)
      .catch(() => setCommitments([]));
  }, [projectId]);

  useEffect(() => {
    void Promise.all([reload(), listPeople(projectId).then(setPeople).catch(() => setPeople([]))]).finally(() =>
      setLoading(false),
    );
  }, [reload, projectId]);

  async function handleToggle(commitment: Commitment) {
    const nextStatus = commitment.status === 'COMPLETED' ? 'IN_PROGRESS' : 'COMPLETED';
    try {
      await updateCommitment(commitment.id, { status: nextStatus });
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  if (loading) return null;
  if (people.length === 0) return null; // нечего привязывать обязательство — сначала нужен хотя бы один фигурант

  return (
    <section className="commitments-section">
      <h3>Обязательства</h3>

      {commitments.length === 0 && !showAddForm && (
        <p className="conversations-section__hint">
          Кто что пообещал и к какому сроку — своё или собеседника. Отмечайте выполненное, просроченное подсветится само.
        </p>
      )}

      <ul className="commitments-list">
        {commitments.map((c) => (
          <CommitmentRow key={c.id} commitment={c} people={people} onToggle={() => handleToggle(c)} />
        ))}
      </ul>

      {showAddForm ? (
        <AddCommitmentForm
          projectId={projectId}
          people={people}
          onDone={() => {
            setShowAddForm(false);
            void reload();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      ) : (
        <button type="button" onClick={() => setShowAddForm(true)}>
          + Добавить обязательство
        </button>
      )}
    </section>
  );
}

function CommitmentRow({
  commitment,
  people,
  onToggle,
}: {
  commitment: Commitment;
  people: ProjectPersonLink[];
  onToggle: () => void;
}) {
  const person = people.find((p) => p.personId === commitment.personId);
  const ownerLabel = commitment.owner === 'USER' ? 'Вы обещали' : `${person?.person.displayName ?? 'Собеседник'} обещал`;

  return (
    <li className={`commitments-list__item${commitment.isOverdue ? ' commitments-list__item--overdue' : ''}`}>
      <label className="commitments-list__row">
        <input
          type="checkbox"
          checked={commitment.status === 'COMPLETED'}
          onChange={onToggle}
        />
        <div className="commitments-list__body">
          <span className="commitments-list__owner">{ownerLabel}</span>
          <span>{commitment.description}</span>
          {commitment.dueDate && (
            <span className="commitments-list__due">
              До {new Date(commitment.dueDate).toLocaleDateString()}
              {commitment.isOverdue && ' — просрочено'}
            </span>
          )}
        </div>
      </label>
    </li>
  );
}

function AddCommitmentForm({
  projectId,
  people,
  onDone,
  onCancel,
}: {
  projectId: string;
  people: ProjectPersonLink[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [personId, setPersonId] = useState(people[0]?.personId ?? '');
  const [owner, setOwner] = useState<CommitmentOwner>('FIGURANT');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!description.trim() || !personId) return;
    setSaving(true);
    setError(null);
    try {
      await createCommitment(projectId, {
        personId,
        owner,
        description: description.trim(),
        dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
      });
      haptic('success');
      onDone();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить обязательство');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="conversations-section__add">
      <label>
        Кто
        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          {people.map((p) => (
            <option key={p.personId} value={p.personId}>
              {p.person.displayName ?? 'Без имени'}
            </option>
          ))}
        </select>
      </label>

      <label>
        Чьё обязательство
        <select value={owner} onChange={(e) => setOwner(e.target.value as CommitmentOwner)}>
          <option value="FIGURANT">Собеседник обещал</option>
          <option value="USER">Я обещал</option>
        </select>
      </label>

      <label>
        Что именно
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Пришлёт документы" />
      </label>

      <label>
        Срок (необязательно)
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>

      {error && <p className="generation-error">{error}</p>}

      <div className="conversations-section__add-actions">
        <button type="button" onClick={handleSubmit} disabled={saving || !description.trim()}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Отмена
        </button>
      </div>
    </div>
  );
}
