'use client';

// Пункт 38 (backend) → TMA UI: Archetype Perspective Simulation
// (§3.11 ТЗ, MVP v3). Уровень проекта, не разговора (в отличие от
// Manipulation Detector/Discrepancy Analysis, встроенных в
// ConversationsSection) — тот же паттерн секции, что PredictionsSection.
//
// Пункт 46: добавлена вторая ветка §3.11 ("глазами реальных
// фигурантов") — REAL_PERSON, ранее честно отложенная. При выборе
// показывается селектор реального человека из уже добавленных в
// проект (listPeople), не текстовый ввод, как у CUSTOM — в отличие
// от произвольной роли, реальный фигурант должен существовать как
// запись Person, иначе backend не сможет подмешать его коммуникационный
// профиль/связи/прецеденты в промпт.

import { useState, useEffect, useCallback } from 'react';
import { NotLoadedNotice } from './NotLoadedNotice';
import { generateArchetypePerspective, listArchetypePerspectives, listPeople } from '../lib/features';
import { AnalysisBasisNote } from './AnalysisBasisNote';
import { ArchetypePerspective, ArchetypeType, ProjectPersonLink } from '../lib/types';
import { haptic } from '../lib/telegram';

interface ArchetypePerspectivesSectionProps {
  projectId: string;
}

const ARCHETYPE_LABELS: Record<ArchetypeType, string> = {
  POLICE_OFFICER: 'Полицейский (законность)',
  LAWYER: 'Юрист (юридические риски)',
  NEIGHBORHOOD_GRANDMOTHER: 'Бабушка у подъезда (репутация)',
  FINANCIAL_ANALYST: 'Финансовый аналитик',
  PSYCHOLOGIST: 'Психолог',
  CHILD: 'Ребёнок (наивный вопрос)',
  JEALOUS_SPOUSE: 'Ревнивая жена (враждебная трактовка)',
  TROUBLEMAKER: 'Скандалист (враждебная трактовка)',
  CUSTOM: 'Свой архетип…',
  REAL_PERSON: 'Реальный человек из проекта…',
};

export function ArchetypePerspectivesSection({ projectId }: ArchetypePerspectivesSectionProps) {
  const [perspectives, setPerspectives] = useState<ArchetypePerspective[]>([]);
  // Пункт [empty-looked-like-an-answer] 2026-09-24: сбой загрузки
  // ставил пустой список и молчал — экран показывал «ничего нет»
  // там, где ответа не было вовсе.
  const [notLoaded, setNotLoaded] = useState(false);
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<ArchetypeType>('LAWYER');
  const [customDescription, setCustomDescription] = useState('');
  const [selectedPersonId, setSelectedPersonId] = useState('');
  const [focusOwnPosition, setFocusOwnPosition] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пункт [partial-basis] 2026-09-04: на чём построена ЭТА перспектива.
  const [basisNote, setBasisNote] = useState<string | null>(null);

  const reload = useCallback(() => {
    return listArchetypePerspectives(projectId)
      .then((v) => { setPerspectives(v); setNotLoaded(false); })
      .catch(() => { setPerspectives([]); setNotLoaded(true); });
  }, [projectId]);

  useEffect(() => {
    void Promise.all([reload(), listPeople(projectId).then((v) => { setPeople(v); setNotLoaded(false); }).catch(() => { setPeople([]); setNotLoaded(true); })]).finally(() =>
      setLoading(false),
    );
  }, [reload, projectId]);

  async function handleGenerate() {
    if (selectedType === 'CUSTOM' && !customDescription.trim()) return;
    if (selectedType === 'REAL_PERSON' && !selectedPersonId) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateArchetypePerspective(
        projectId,
        selectedType,
        selectedType === 'CUSTOM' ? customDescription.trim() : undefined,
        selectedType === 'REAL_PERSON' ? selectedPersonId : undefined,
        focusOwnPosition,
      );
      setPerspectives((prev) => [result, ...prev]);
      setBasisNote(result.basisNote);
      if (selectedType === 'CUSTOM') setCustomDescription('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось построить перспективу');
    } finally {
      setGenerating(false);
    }
  }

  function labelForPerspective(p: ArchetypePerspective): string {
    if (p.archetypeType === 'CUSTOM') return p.customArchetypeDescription ?? 'Свой архетип';
    if (p.archetypeType === 'REAL_PERSON') {
      const person = people.find((link) => link.personId === p.targetPersonId);
      return person?.person.displayName ?? 'Реальный человек';
    }
    return ARCHETYPE_LABELS[p.archetypeType as ArchetypeType];
  }

  if (loading) return null;

  return (
    <section className="archetype-perspectives-section">
      {notLoaded && <NotLoadedNotice what="прошлые взгляды и список людей проекта" />}
      <h3>Взгляд глазами других</h3>
      <AnalysisBasisNote note={basisNote} />
      <p className="conversations-section__hint">
        🟡 Догадка ИИ — симуляция мнения, не факт. Некоторые архетипы намеренно предвзяты — это стресс-тест для вашей
        позиции, не поиск объективной истины. Для реального человека — на основе того, что о нём реально известно
        (коммуникационный профиль, связи, прецеденты), без домыслов.
      </p>

      {perspectives.length > 0 && (
        <ul className="archetype-perspectives-list">
          {perspectives.map((p) => (
            <li key={p.id} className="archetype-perspectives-list__item">
              <span className="archetype-perspectives-list__label">
                🟡 {labelForPerspective(p)}
                {p.focusOnOwnPositionWeaknesses && ' — критика вашей позиции'}
              </span>
              <span>{p.reaction}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="conversations-section__add">
        <label className="archetype-perspectives-section__checkbox">
          <input type="checkbox" checked={focusOwnPosition} onChange={(e) => setFocusOwnPosition(e.target.checked)} />
          Искать слабые места в моей собственной аргументации (§3.17 ТЗ), не общую реакцию на ситуацию
        </label>
        <label>
          Чья точка зрения
          <select value={selectedType} onChange={(e) => setSelectedType(e.target.value as ArchetypeType)}>
            {(Object.keys(ARCHETYPE_LABELS) as ArchetypeType[]).map((type) => (
              <option key={type} value={type}>
                {ARCHETYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        {selectedType === 'CUSTOM' && (
          <label>
            Опишите свой архетип
            <input
              value={customDescription}
              onChange={(e) => setCustomDescription(e.target.value)}
              placeholder="Например: строгий бывший армейский командир"
            />
          </label>
        )}
        {selectedType === 'REAL_PERSON' && (
          <label>
            Кто именно
            {people.length > 0 ? (
              <select value={selectedPersonId} onChange={(e) => setSelectedPersonId(e.target.value)}>
                <option value="">Выберите человека</option>
                {people.map((link) => (
                  <option key={link.personId} value={link.personId}>
                    {link.person.displayName ?? 'Без имени'}
                  </option>
                ))}
              </select>
            ) : (
              <span className="conversations-section__hint">
                Сначала добавьте человека в разделе «Участники разговора».
              </span>
            )}
          </label>
        )}
        {error && <p role="alert" className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={
              generating ||
              (selectedType === 'CUSTOM' && !customDescription.trim()) ||
              (selectedType === 'REAL_PERSON' && !selectedPersonId)
            }
          >
            {generating ? 'Строим перспективу…' : 'Получить взгляд с этой точки зрения'}
          </button>
        </div>
      </div>
    </section>
  );
}
