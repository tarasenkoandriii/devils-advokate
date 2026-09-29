'use client';

// Пункт 58 (backend) → TMA UI: минимальный facts-list UI (§4.2 ТЗ) +
// предупреждение о геометках EXIF (§3.19 ТЗ), пункт 29 v3-роадмапа.
// Пункт 89 расширил на видео (.mp4/.mov) — тем же вызовом
// checkExifForGeoTag()/stripExifMetadata(), диспетчеризация по
// формату внутри lib/exif-check.ts, эта секция не изменилась в
// логике, только accept-атрибут поля файла и текст предупреждения
// ("в этом файле", не буквально "в этом фото").
// Первый в проекте UI, позволяющий СОЗДАТЬ PersonFact — до этого
// пункта такой возможности не было вообще ни у одного компонента.
//
// EXIF-ПРОВЕРКА — ЦЕЛИКОМ НА КЛИЕНТЕ (см. lib/exif-check.ts), файл
// НИКОГДА не отправляется на сервер, даже для этой проверки — только
// вычисленный результат (hasGeoTag/metadataStripped) уходит в
// createPersonFact(). Сам файл на сервер не загружается вообще —
// fileRef хранит только имя файла как клиентскую ссылку "напомнить,
// какой файл имелся в виду", не путь загрузки.

import { useState, useEffect, useCallback } from 'react';
import { NotLoadedNotice } from './NotLoadedNotice';
import type { ChangeEvent } from 'react';
import { createPersonFact, listPersonFacts } from '../lib/features';
import { checkExifForGeoTag, stripExifMetadata } from '../lib/exif-check';
import { FactSourceType, PersonFact } from '../lib/types';
import { haptic } from '../lib/telegram';
import { PhotoVerificationSection } from './PhotoVerificationSection';
import { factSourceLabel, factStatusLabel, isGuess } from '../lib/fact-provenance';
import { confirmPersonFact, setPersonFactStatus, deletePersonFact } from '../lib/features';

interface PersonFactsSectionProps {
  personId: string;
  projectId: string;
}

const SOURCE_TYPE_OPTIONS: { value: FactSourceType; label: string }[] = [
  { value: 'PERSONAL_RECORD', label: '🟢 Личная запись (видел/слышал сам)' },
  { value: 'PUBLIC_FACT', label: '🔵 Публичный факт' },
  { value: 'USER_GUESS', label: '⚪ Моё предположение' },
];

export function PersonFactsSection({ personId, projectId }: PersonFactsSectionProps) {
  const [facts, setFacts] = useState<PersonFact[]>([]);
  // Пункт [empty-looked-like-an-answer] 2026-09-24: сбой загрузки
  // ставил пустой список и молчал — экран показывал «ничего нет»
  // там, где ответа не было вовсе.
  const [notLoaded, setNotLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  const [content, setContent] = useState('');
  const [sourceType, setSourceType] = useState<FactSourceType>('PERSONAL_RECORD');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [geoCheck, setGeoCheck] = useState<{ hasGeoTag: boolean; metadataStripped: boolean } | null>(null);
  const [checkingExif, setCheckingExif] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пункт [no-correction] 2026-09-05: над какой записью идёт действие и
  // какая ждёт подтверждения удаления. Удаление — единственное
  // необратимое из четырёх, поэтому спрашивается отдельно.
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(() => {
    return listPersonFacts(personId)
      .then((v) => { setFacts(v); setNotLoaded(false); })
      .catch(() => { setFacts([]); setNotLoaded(true); });
  }, [personId]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setCheckingExif(true);
    try {
      const result = await checkExifForGeoTag(file);
      setGeoCheck({ hasGeoTag: result.hasGeoTag, metadataStripped: false });
    } finally {
      setCheckingExif(false);
    }
  }

  async function handleStripMetadata() {
    if (!selectedFile) return;
    const stripped = await stripExifMetadata(selectedFile);
    setSelectedFile(stripped);
    setGeoCheck({ hasGeoTag: false, metadataStripped: true });
    haptic('success');
  }

  async function handleSubmit() {
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPersonFact(personId, {
        content: content.trim(),
        sourceType,
        projectId,
        source: selectedFile
          ? {
              fileRef: selectedFile.name,
              hasGeoTag: geoCheck?.hasGeoTag ?? undefined,
              metadataStripped: geoCheck?.metadataStripped ?? undefined,
            }
          : undefined,
      });
      await reload();
      setContent('');
      setSelectedFile(null);
      setGeoCheck(null);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить факт');
    } finally {
      setSubmitting(false);
    }
  }

  async function runOnFact(factId: string, action: () => Promise<unknown>, failure: string) {
    setBusyFactId(factId);
    setError(null);
    try {
      await action();
      await reload();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyFactId(null);
      setConfirmDeleteId(null);
    }
  }

  if (loading) return null;

  return (
    <section className="person-facts-section">
      {notLoaded && <NotLoadedNotice what="личные факты" />}
      <h3>Факты</h3>

      {facts.length > 0 && (
        <ul className="person-facts-section__list">
          {facts.map((f) => (
            <li key={f.id} className="person-facts-section__item">
              {/* Пункт [source-collapse] 2026-09-05: происхождение
                  показывается ТАМ ЖЕ, где текст факта. Человек выбирал
                  его при вводе и больше никогда не видел — через неделю
                  собственная догадка читалась как установленное. */}
              <span className="person-facts-section__source">{factSourceLabel(f.sourceType)}</span>
              <span>{f.content}</span>
              {factStatusLabel(f.status) && (
                <span className="person-facts-section__status">{factStatusLabel(f.status)}</span>
              )}
              {isGuess(f.sourceType) && (
                <span className="person-facts-section__source-note">
                  Это ваше предположение. В разборы оно идёт с этой пометкой — как догадка, не как факт.
                </span>
              )}
              {/* Пункт [no-correction] 2026-09-05: до этого захода у
                  записи о человеке было ровно два действия — создать и
                  прочитать. Ни подтвердить, ни оспорить, ни удалить,
                  при том что схема знала DISPUTED и EXPIRED и три
                  сервиса на них ветвились. */}
              <span className="person-facts-section__actions">
                <button type="button" disabled={busyFactId === f.id}
                  onClick={() => runOnFact(f.id, () => confirmPersonFact(personId, f.id), 'Не удалось подтвердить факт')}>
                  Подтвердить
                </button>
                {f.status !== 'DISPUTED' && (
                  <button type="button" disabled={busyFactId === f.id}
                    onClick={() => runOnFact(f.id, () => setPersonFactStatus(personId, f.id, 'DISPUTED'), 'Не удалось отметить факт как неверный')}>
                    Это неверно
                  </button>
                )}
                {f.status !== 'EXPIRED' && (
                  <button type="button" disabled={busyFactId === f.id}
                    onClick={() => runOnFact(f.id, () => setPersonFactStatus(personId, f.id, 'EXPIRED'), 'Не удалось отметить факт как неактуальный')}>
                    Больше не актуально
                  </button>
                )}
                {confirmDeleteId === f.id ? (
                  <>
                    {/* Единственное необратимое действие из четырёх —
                        поэтому спрашивается отдельно, и сказано, чего
                        удаление НЕ делает. */}
                    <span className="person-facts-section__source-note">
                      Удалить запись? Выводы, уже построенные с её участием — черты профиля, прецеденты, — останутся:
                      они ссылаются на источник текстом, и связать их с этой записью нечем.
                    </span>
                    <button type="button" disabled={busyFactId === f.id}
                      onClick={() => runOnFact(f.id, () => deletePersonFact(personId, f.id), 'Не удалось удалить факт')}>
                      Да, удалить
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(null)}>Отмена</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmDeleteId(f.id)}>Удалить</button>
                )}
              </span>
              {f.sources.map((s) => (
                <span key={s.id} className="person-facts-section__source-note">
                  {s.hasGeoTag === true && !s.metadataStripped && '⚠️ в исходном файле были координаты съёмки'}
                  {s.metadataStripped && '✓ метаданные очищены перед сохранением'}
                  {s.hasGeoTag === false && !s.metadataStripped && 'геометок не найдено'}
                </span>
              ))}
              {/* Пункт 48 (backend) — точка входа найдена и подключена
                  только сейчас (Пункт 58): компонент был готов и
                  компилировался с самого Пункта 48, но не имел, куда
                  смонтироваться, пока не появился этот facts-list UI. */}
              {f.sources.some((s) => s.fileRef) && <PhotoVerificationSection personFactId={f.id} />}
            </li>
          ))}
        </ul>
      )}

      <div className="conversations-section__add">
        <label>
          Факт
          <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Что вы узнали или заметили" />
        </label>
        <label>
          Источник
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as FactSourceType)}>
            {SOURCE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Приложить фото или видео (необязательно)
          <input type="file" accept="image/*,video/mp4,video/quicktime,.mp4,.mov" onChange={handleFileSelected} />
        </label>

        {checkingExif && <p className="conversations-section__hint">Проверяем метаданные…</p>}

        {geoCheck?.hasGeoTag && (
          <div className="person-facts-section__geo-warning">
            <p>⚠️ В этом файле зашиты координаты места съёмки.</p>
            <button type="button" onClick={handleStripMetadata}>
              Очистить метаданные перед сохранением
            </button>
          </div>
        )}
        {geoCheck?.metadataStripped && <p className="conversations-section__hint">✓ Метаданные очищены.</p>}

        {error && <p role="alert" className="generation-error">{error}</p>}
        <div className="conversations-section__add-actions">
          <button type="button" onClick={handleSubmit} disabled={submitting || !content.trim()}>
            {submitting ? 'Сохраняем…' : 'Сохранить факт'}
          </button>
        </div>
      </div>
    </section>
  );
}
