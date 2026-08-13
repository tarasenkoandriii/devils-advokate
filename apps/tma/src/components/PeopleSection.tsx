'use client';

// MVP-фича 7: секция фигурантов на странице проекта — минимальная
// реализация фичи 3 в UI (раньше была только на бэкенде) плюс
// генерация Steelman-кейса для каждого. Не полноценный "круг лиц"
// (§3.8 ТЗ, v3-фича) — просто список + кнопка, достаточно для MVP.

import { useEffect, useState } from 'react';
import {
  addPerson,
  createRelationship,
  deleteRelationship,
  detectSourceConflicts,
  findPrecedents,
  generateSteelman,
  getCommunicationProfile,
  listPeople,
  listPrecedents,
  listRelationshipsForPerson,
  listSourceConflicts,
  listStaleFactsByPerson,
  listSteelmanCases,
  refreshCommunicationProfile,
  removePerson,
  resolveSourceConflict,
  suggestRelationships,
  updatePersonStatus,
} from '../lib/features';
import {
  PersonCommunicationTrait,
  PersonStatus,
  PrecedentSearchResult,
  ProjectPersonLink,
  Relationship,
  RelationshipDirection,
  RelationshipSuggestion,
  RelationshipType,
  SourceConflict,
  StaleFactWarning,
  SteelmanCase,
} from '../lib/types';
import { haptic } from '../lib/telegram';
import { PersonFactsSection } from './PersonFactsSection';
import { MotiveAnalysisSection } from './MotiveAnalysisSection';

// Пункт 39: те же шесть признаков, что в backend TRAIT_LABELS
// (communication-profile.service.ts) — не изобретены заново на фронтенде.
const COMMUNICATION_TRAIT_LABELS: Record<PersonCommunicationTrait['traitType'], string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'Предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'Предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'Нужно время на решение',
  RESPONDS_TO_DATA: 'Реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'Избегание конфликта',
  DECISION_MAKING_STYLE: 'Стиль принятия решений',
};

interface PeopleSectionProps {
  projectId: string;
}

export function PeopleSection({ projectId }: PeopleSectionProps) {
  const [people, setPeople] = useState<ProjectPersonLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  function reload() {
    return listPeople(projectId)
      .then(setPeople)
      .catch(() => setPeople([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await addPerson(projectId, name);
      setNewName('');
      await reload();
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setAdding(false);
    }
  }

  // Пункт 43: Relationship (§3.13 ТЗ) — подсказки по совместному
  // участию в разговоре, чистый DB-запрос без AI (см.
  // relationships.service.ts). Чисто информационные — добавление
  // самой связи происходит в карточке конкретной персоны ниже, не
  // отсюда, ради простоты формы на мобильном экране.
  const [suggestions, setSuggestions] = useState<RelationshipSuggestion[]>([]);

  useEffect(() => {
    suggestRelationships()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, [projectId]);

  if (loading) return null;

  return (
    <section className="people-section">
      <h3>Участники разговора</h3>

      {people.length === 0 && (
        <p className="people-section__hint">
          Добавьте человека, с которым предстоит разговор, чтобы построить Steelman его позиции.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="relationship-suggestions">
          <p className="people-section__hint">
            Эти люди участвовали в общих разговорах — возможно, стоит указать связь между ними (в карточке любого из них ниже):
          </p>
          <ul className="relationship-suggestions__list">
            {suggestions.map((s) => (
              <li key={`${s.personAId}:${s.personBId}`} className="relationship-suggestions__item">
                {s.personA?.displayName ?? '?'} ↔ {s.personB?.displayName ?? '?'} — {s.sharedConversations} общих разговор(а)
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="people-list">
        {people.map((link) => (
          <PersonRow key={link.personId} projectId={projectId} link={link} allPeople={people} onChanged={reload} />
        ))}
      </ul>

      <div className="people-section__add">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Например: Начальник Иван"
        />
        <button type="button" onClick={handleAdd} disabled={adding || !newName.trim()}>
          {adding ? 'Добавляем…' : 'Добавить'}
        </button>
      </div>
    </section>
  );
}

function PersonRow({
  projectId,
  link,
  allPeople,
  onChanged,
}: {
  projectId: string;
  link: ProjectPersonLink;
  allPeople: ProjectPersonLink[];
  onChanged: () => void;
}) {
  const [cases, setCases] = useState<SteelmanCase[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Пункт 30 (аудит) — раньше нигде не вызывались, хотя backend был
  // готов и протестирован (persons.service.ts, 10 тестов) ещё с
  // чекпоинта 1. Найдено систематической сверкой эндпоинтов.
  const [changingStatus, setChangingStatus] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleStatusChange(newStatus: PersonStatus) {
    if (newStatus === link.status) return;
    setChangingStatus(true);
    try {
      await updatePersonStatus(projectId, link.personId, newStatus);
      onChanged();
      haptic('success');
    } catch {
      haptic('error');
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await removePerson(projectId, link.personId);
      onChanged();
      haptic('success');
    } catch {
      haptic('error');
      setRemoving(false);
    }
    // не сбрасываем removing в finally при успехе — строка сейчас
    // исчезнет из списка родителя (onChanged перезагрузит people),
    // возвращать disabled-кнопку в исчезающий DOM-узел незачем
  }

  useEffect(() => {
    if (!expanded) return;
    listSteelmanCases(projectId, link.personId)
      .then(setCases)
      .catch(() => setCases([]));
  }, [expanded, projectId, link.personId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const result = await generateSteelman(projectId, link.personId);
      setCases((prev) => [result, ...prev]);
      setExpanded(true);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось построить Steelman-кейс');
    } finally {
      setGenerating(false);
    }
  }

  // Пункт 21: Source Conflict Resolver (§3.56 ТЗ) — конфликты между
  // фактами об ЭТОМ фигуранте (не привязано к projectId — Person
  // может фигурировать в нескольких проектах, конфликт его фактов не
  // свойство одного проекта, см. SourceConflictService на бэкенде).
  const [conflicts, setConflicts] = useState<SourceConflict[]>([]);
  const [detectingConflicts, setDetectingConflicts] = useState(false);
  const [conflictsError, setConflictsError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    listSourceConflicts(link.personId)
      .then(setConflicts)
      .catch(() => setConflicts([]));
  }, [expanded, link.personId]);

  async function handleDetectConflicts() {
    setDetectingConflicts(true);
    setConflictsError(null);
    try {
      await detectSourceConflicts(link.personId);
      const list = await listSourceConflicts(link.personId);
      setConflicts(list);
      haptic('success');
    } catch (err) {
      haptic('error');
      setConflictsError(
        err instanceof Error ? err.message : 'Не удалось проверить факты на противоречия',
      );
    } finally {
      setDetectingConflicts(false);
    }
  }

  async function handleResolveConflict(conflictId: string) {
    try {
      await resolveSourceConflict(conflictId);
      setConflicts((prev) =>
        prev.map((c) => (c.id === conflictId ? { ...c, resolvedAt: new Date().toISOString() } : c)),
      );
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  const unresolvedConflicts = conflicts.filter((c) => !c.resolvedAt);

  // Пункт 22: Stale Fact Alert (§3.57 ТЗ) — детерминированная
  // выборка, загружается вместе с остальным содержимым карточки
  // персоны, без отдельной кнопки "проверить" (в отличие от Source
  // Conflict Resolver выше — там AI-вызов, здесь просто чтение поля).
  const [staleFacts, setStaleFacts] = useState<StaleFactWarning[]>([]);

  useEffect(() => {
    if (!expanded) return;
    listStaleFactsByPerson(link.personId)
      .then(setStaleFacts)
      .catch(() => setStaleFacts([]));
  }, [expanded, link.personId]);

  // Пункт 39: Communication Profile (§3.11 ТЗ текст, роадмап-пункт 24
  // v3) — та же механика загрузки, что stale-facts выше (грузится
  // сразу при разворачивании), но с явной кнопкой "Обновить" —
  // накопительное обновление требует AI-вызова (в отличие от
  // stale-facts, детерминированной выборки), не должно происходить
  // автоматически при каждом разворачивании карточки.
  const [communicationProfile, setCommunicationProfile] = useState<PersonCommunicationTrait[]>([]);
  const [refreshingProfile, setRefreshingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    getCommunicationProfile(link.personId)
      .then(setCommunicationProfile)
      .catch(() => setCommunicationProfile([]));
  }, [expanded, link.personId]);

  async function handleRefreshProfile() {
    setRefreshingProfile(true);
    setProfileError(null);
    try {
      const updated = await refreshCommunicationProfile(link.personId);
      setCommunicationProfile(updated);
      haptic('success');
    } catch (err) {
      haptic('error');
      setProfileError(err instanceof Error ? err.message : 'Не удалось обновить профиль');
    } finally {
      setRefreshingProfile(false);
    }
  }

  // Пункт 43: Relationship (§3.13 ТЗ) — "первый слой" графа связей.
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [addingRelationship, setAddingRelationship] = useState(false);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [otherPersonId, setOtherPersonId] = useState('');
  const [relType, setRelType] = useState<RelationshipType>('SOCIAL');
  const [relLabel, setRelLabel] = useState('');
  const [relDirection, setRelDirection] = useState<RelationshipDirection>('MUTUAL');

  useEffect(() => {
    if (!expanded) return;
    listRelationshipsForPerson(link.personId)
      .then(setRelationships)
      .catch(() => setRelationships([]));
  }, [expanded, link.personId]);

  async function handleAddRelationship() {
    if (!otherPersonId || !relLabel.trim()) return;
    setAddingRelationship(true);
    setRelationshipError(null);
    try {
      await createRelationship({
        personAId: link.personId,
        personBId: otherPersonId,
        type: relType,
        label: relLabel.trim(),
        direction: relDirection,
        sourceType: 'PERSONAL_RECORD',
      });
      const list = await listRelationshipsForPerson(link.personId);
      setRelationships(list);
      setRelLabel('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setRelationshipError(err instanceof Error ? err.message : 'Не удалось добавить связь');
    } finally {
      setAddingRelationship(false);
    }
  }

  async function handleDeleteRelationship(relationshipId: string) {
    try {
      await deleteRelationship(relationshipId);
      setRelationships((prev) => prev.filter((r) => r.id !== relationshipId));
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  // Пункт 45: Precedent Search (§3.9 ТЗ) — только из личных записей
  // (прошлые разговоры + факты), без публичного поиска.
  const [precedentResult, setPrecedentResult] = useState<PrecedentSearchResult | null>(null);
  const [situationInput, setSituationInput] = useState('');
  const [searchingPrecedents, setSearchingPrecedents] = useState(false);
  const [precedentError, setPrecedentError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    listPrecedents(link.personId)
      .then(setPrecedentResult)
      .catch(() => setPrecedentResult(null));
  }, [expanded, link.personId]);

  async function handleFindPrecedents() {
    if (!situationInput.trim()) return;
    setSearchingPrecedents(true);
    setPrecedentError(null);
    try {
      await findPrecedents(link.personId, situationInput.trim());
      const result = await listPrecedents(link.personId);
      setPrecedentResult(result);
      setSituationInput('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setPrecedentError(err instanceof Error ? err.message : 'Не удалось найти прецеденты');
    } finally {
      setSearchingPrecedents(false);
    }
  }

  const otherPeopleOptions = allPeople.filter((p) => p.personId !== link.personId);

  return (
    <li className="people-list__item">
      <div className="people-list__name">{link.person.displayName ?? 'Без имени'}</div>
      <div className="people-list__row">
        <select
          value={link.status}
          disabled={changingStatus}
          onChange={(e) => handleStatusChange(e.target.value as PersonStatus)}
          title="Персона — общий контакт; Фигурант — конкретно значимый для этого решения человек"
        >
          <option value="PERSONA">Персона</option>
          <option value="FIGURANT">Фигурант</option>
        </select>
        <button type="button" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Строим…' : 'Steelman'}
        </button>
        <button type="button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Свернуть' : 'Подробнее'}
        </button>
        <button
          type="button"
          className="people-list__remove"
          onClick={handleRemove}
          disabled={removing}
          title="Удалить из этого проекта — сама персона (и её факты) не удаляется, только связь с проектом"
        >
          {removing ? '…' : '✕'}
        </button>
      </div>

      {error && <p className="generation-error">{error}</p>}

      {expanded && cases.length > 0 && (
        <div className="steelman-cases">
          {cases.map((c) => (
            <div key={c.id} className="steelman-case">
              <p className="steelman-case__label">Сильнейший аргумент</p>
              <p>{c.strongestArgument}</p>
              {c.reasonableness && (
                <>
                  <p className="steelman-case__label">Почему это разумно с его точки зрения</p>
                  <p>{c.reasonableness}</p>
                </>
              )}
              {c.whatUserMayMiss && (
                <>
                  <p className="steelman-case__label">Что вы можете упускать</p>
                  <p>{c.whatUserMayMiss}</p>
                </>
              )}
              <span className="arguments-list__source-tag" title="Догадка ИИ — не факт">
                🟡
              </span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="source-conflicts">
          <button type="button" onClick={handleDetectConflicts} disabled={detectingConflicts}>
            {detectingConflicts ? 'Проверяем факты…' : 'Проверить факты на противоречия'}
          </button>
          {conflictsError && <p className="generation-error">{conflictsError}</p>}

          {unresolvedConflicts.length > 0 && (
            <ul className="source-conflicts__list">
              {unresolvedConflicts.map((conflict) => (
                <li key={conflict.id} className="source-conflict">
                  <p className="source-conflict__description">{conflict.conflictDescription}</p>
                  <p className="source-conflict__fact">Факт A: {conflict.factA.content}</p>
                  <p className="source-conflict__fact">Факт B: {conflict.factB.content}</p>
                  {conflict.possibleExplanations.length > 0 && (
                    <div>
                      <p className="steelman-case__label">Возможные объяснения</p>
                      <ul>
                        {conflict.possibleExplanations.map((exp, i) => (
                          <li key={i}>{exp}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="source-conflict__question">Уточнить: {conflict.clarifyingQuestion}</p>
                  <button type="button" onClick={() => handleResolveConflict(conflict.id)}>
                    Отметить разобранным
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {expanded && staleFacts.length > 0 && (
        <div className="stale-facts">
          {staleFacts.map((f) => (
            <p key={f.id} className="stale-facts__item">
              <span className="stale-facts__age">{Math.floor(f.ageInDays / 30)} мес. назад:</span> {f.content}
            </p>
          ))}
        </div>
      )}
      {expanded && (
        <div className="communication-profile">
          <p className="steelman-case__label">Коммуникационный профиль (наблюдения, не тип личности)</p>
          {communicationProfile.length > 0 ? (
            <ul className="communication-profile__list">
              {communicationProfile.map((t) => (
                <li key={t.id} className="communication-profile__item">
                  <span className="communication-profile__trait">{COMMUNICATION_TRAIT_LABELS[t.traitType as PersonCommunicationTrait['traitType']]}</span>
                  <span>{t.value}</span>
                  <span className="communication-profile__source">На основании: {t.observedFrom}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="conversations-section__hint">Пока не обновлялся — нужны факты или расшифрованные разговоры с этим человеком.</p>
          )}
          {profileError && <p className="generation-error">{profileError}</p>}
          <button type="button" onClick={handleRefreshProfile} disabled={refreshingProfile}>
            {refreshingProfile ? 'Анализируем…' : 'Обновить профиль'}
          </button>
        </div>
      )}
      {expanded && (
        <div className="relationships-block">
          <p className="steelman-case__label">Связи с другими фигурантами</p>
          {relationships.length > 0 ? (
            <ul className="relationships-block__list">
              {relationships.map((r) => {
                const isA = r.personAId === link.personId;
                const other = isA ? r.personB : r.personA;
                return (
                  <li key={r.id} className="relationships-block__item">
                    <span>{other?.displayName ?? '?'} — {r.label}</span>
                    <button type="button" onClick={() => handleDeleteRelationship(r.id)}>
                      Удалить
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="conversations-section__hint">Связей пока не указано.</p>
          )}
          {otherPeopleOptions.length > 0 && (
            <div className="conversations-section__add">
              <label>
                С кем
                <select value={otherPersonId} onChange={(e) => setOtherPersonId(e.target.value)}>
                  <option value="">Выберите человека</option>
                  {otherPeopleOptions.map((p) => (
                    <option key={p.personId} value={p.personId}>
                      {p.person.displayName ?? 'Без имени'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Тип
                <select value={relType} onChange={(e) => setRelType(e.target.value as RelationshipType)}>
                  <option value="FAMILY">Родственная</option>
                  <option value="HIERARCHY">Рабочая иерархия</option>
                  <option value="SOCIAL">Социальная</option>
                </select>
              </label>
              <label>
                В чём суть связи
                <input
                  value={relLabel}
                  onChange={(e) => setRelLabel(e.target.value)}
                  placeholder="Например: непосредственный руководитель"
                />
              </label>
              <label>
                Направление
                <select value={relDirection} onChange={(e) => setRelDirection(e.target.value as RelationshipDirection)}>
                  <option value="A_TO_B">Применимо от этого человека к тому</option>
                  <option value="B_TO_A">Применимо от того человека к этому</option>
                  <option value="MUTUAL">Взаимно (например, братья/коллеги)</option>
                </select>
              </label>
              {relationshipError && <p className="generation-error">{relationshipError}</p>}
              <div className="conversations-section__add-actions">
                <button
                  type="button"
                  onClick={handleAddRelationship}
                  disabled={addingRelationship || !otherPersonId || !relLabel.trim()}
                >
                  {addingRelationship ? 'Добавляем…' : 'Добавить связь'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className="precedent-search-block">
          <p className="steelman-case__label">Прецеденты поведения (из личных записей)</p>
          <p className="conversations-section__hint">
            Только по прошлым разговорам и фактам, уже сохранённым здесь — без поиска в интернете.
          </p>
          {precedentResult && precedentResult.total > 0 && (
            <>
              <p className="precedent-search-block__conclusion">{precedentResult.conclusion}</p>
              <ul className="precedent-search-block__list">
                {precedentResult.precedents.map((p) => (
                  <li key={p.id} className={`precedent-search-block__item precedent-search-block__item--${p.similarity.toLowerCase()}`}>
                    <span className="precedent-search-block__badge">
                      {p.similarity === 'ANALOGOUS' && 'Аналогичный кейс'}
                      {p.similarity === 'PARTIALLY_SIMILAR' && 'Частично похожий'}
                      {p.similarity === 'CONTRASTING' && 'Контрастный пример'}
                    </span>
                    <span>{p.precedentDescription}</span>
                    <span className="precedent-search-block__source">Источник: {p.sourceDescription}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="conversations-section__add">
            <label>
              Для какой ситуации искать прецедент
              <input
                value={situationInput}
                onChange={(e) => setSituationInput(e.target.value)}
                placeholder="Например: хочу попросить отгул на пятницу"
              />
            </label>
            {precedentError && <p className="generation-error">{precedentError}</p>}
            <div className="conversations-section__add-actions">
              <button
                type="button"
                onClick={handleFindPrecedents}
                disabled={searchingPrecedents || !situationInput.trim()}
              >
                {searchingPrecedents ? 'Ищем…' : 'Найти прецеденты'}
              </button>
            </div>
          </div>
        </div>
      )}
      {expanded && <PersonFactsSection personId={link.personId} projectId={projectId} />}
      {expanded && (
        <MotiveAnalysisSection
          personId={link.personId}
          projectId={projectId}
          currentStatus={link.status}
          onStatusConfirmed={onChanged}
        />
      )}
    </li>
  );
}
