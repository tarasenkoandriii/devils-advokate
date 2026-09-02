'use client';

// Пункт 44 (backend) → TMA UI: Stakeholder Map (§3.8 ТЗ), доводит до
// конца пункт 20 v3-роадмапа. Визуализация графа НЕ реализована (сама
// ТЗ называет её опциональной) — список ролей + аргументы под
// каждого, явно не смешанные между собой.

import { useState, useEffect, useCallback } from 'react';
import {
  confirmStakeholderRole,
  generateArgumentsForStakeholder,
  listStakeholderMap,
  suggestStakeholderRoles,
} from '../lib/features';
import { RoleSuggestion, StakeholderMapEntry, StakeholderRole, SuggestRolesResult } from '../lib/types';
import { haptic } from '../lib/telegram';

interface StakeholderMapSectionProps {
  projectId: string;
}

const ROLE_LABELS: Record<StakeholderRole, string> = {
  DECISION_MAKER: 'Прямой решающий',
  ADVISOR: 'Влияющий советчик',
  BLOCKER: 'Блокер',
  ALLY: 'Союзник',
};

export function StakeholderMapSection({ projectId }: StakeholderMapSectionProps) {
  const [map, setMap] = useState<StakeholderMapEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<SuggestRolesResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);

  const reloadMap = useCallback(() => {
    return listStakeholderMap(projectId)
      .then(setMap)
      .catch(() => setMap([]));
  }, [projectId]);

  useEffect(() => {
    void reloadMap().finally(() => setLoading(false));
  }, [reloadMap]);

  async function handleSuggest() {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const result = await suggestStakeholderRoles(projectId);
      setSuggestions(result);
      haptic('success');
    } catch (err) {
      haptic('error');
      setSuggestError(err instanceof Error ? err.message : 'Не удалось построить карту круга лиц');
    } finally {
      setSuggesting(false);
    }
  }

  async function handleConfirmRole(suggestion: RoleSuggestion) {
    try {
      await confirmStakeholderRole(projectId, suggestion.personId, suggestion.role);
      setSuggestions((prev) =>
        prev ? { ...prev, roleSuggestions: prev.roleSuggestions.filter((s) => s.personId !== suggestion.personId) } : prev,
      );
      await reloadMap();
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  async function handleGenerateArguments(personId: string) {
    setGeneratingFor(personId);
    try {
      await generateArgumentsForStakeholder(projectId, personId);
      await reloadMap();
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setGeneratingFor(null);
    }
  }

  if (loading) return null;

  return (
    <section className="stakeholder-map-section">
      <h3>Круг лиц, влияющих на решение</h3>
      <p className="conversations-section__hint">
        Для каждого человека — свой набор аргументов, то, что убедит именно его. Разные фигуранты могут требовать
        противоречащих друг другу аргументов — это нормально, они показаны отдельно.
      </p>

      {map.length > 0 && (
        <ul className="stakeholder-map__list">
          {map.map((entry) => (
            <li key={entry.personId} className="stakeholder-map__item">
              <div className="stakeholder-map__header">
                <span className="stakeholder-map__name">{entry.displayName ?? 'Без имени'}</span>
                <span className="stakeholder-map__role">{ROLE_LABELS[entry.role as StakeholderRole]}</span>
              </div>
              {entry.arguments.length > 0 ? (
                <ul className="stakeholder-map__arguments">
                  {entry.arguments.map((arg) => (
                    <li key={arg.id} className={`stakeholder-map__argument stakeholder-map__argument--${arg.stance.toLowerCase()}`}>
                      {arg.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="conversations-section__hint">Аргументов для этого человека пока нет.</p>
              )}
              <button
                type="button"
                onClick={() => handleGenerateArguments(entry.personId)}
                disabled={generatingFor === entry.personId}
              >
                {generatingFor === entry.personId ? 'Строим аргументы…' : 'Сгенерировать аргументы для этого человека'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggestError && <p className="generation-error">{suggestError}</p>}
      <button type="button" onClick={handleSuggest} disabled={suggesting}>
        {suggesting ? 'Анализируем круг лиц…' : 'Найти круг лиц'}
      </button>

      {suggestions && (
        <div className="stakeholder-suggestions">
          {suggestions.roleSuggestions.length > 0 && (
            <>
              <p className="steelman-case__label">Предложенные роли — подтвердите или пропустите</p>
              <ul className="stakeholder-suggestions__list">
                {suggestions.roleSuggestions.map((s) => (
                  <li key={s.personId} className="stakeholder-suggestions__item">
                    <span>{ROLE_LABELS[s.role as StakeholderRole]} — {s.reasoning}</span>
                    <button type="button" onClick={() => handleConfirmRole(s)}>
                      Подтвердить
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {suggestions.gapSuggestions.length > 0 && (
            <>
              <p className="steelman-case__label">Возможно, в круге лиц кого-то не хватает</p>
              <ul className="stakeholder-suggestions__gaps">
                {suggestions.gapSuggestions.map((g, i) => (
                  <li key={i}>{g.roleHint} — {g.reasoning}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
