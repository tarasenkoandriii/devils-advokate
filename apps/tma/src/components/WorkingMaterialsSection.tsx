'use client';

// Пункт 60 (backend) → TMA UI: Working Materials (§3.27 ТЗ), реализовано
// в честно суженном объёме — только .md/PPTX, без фото/графиков (см.
// подробное обоснование в apps/api/prisma/README.md, «Пункт 60»).
// Пункт 91 добавил голосовой чат с AI (MaterialChatSection.tsx) —
// критика фото/графиков остаётся честно не реализованной, но
// голосовой режим больше не блокирован.
//
// ДИСКЛЕЙМЕР ПРО ЛОКАЛЬНОСТЬ ФАЙЛА — "показывается перед первой
// загрузкой материала" (буквально ТЗ) — здесь как постоянная видимая
// подсказка над формой загрузки, не блокирующий экран согласия: AI-
// вызов уже защищён существующим EXTERNAL_AI-согласием на уровне
// AIRouterService (та же инфраструктура, что у всех остальных AI-фич
// проекта), здесь не изобретается отдельный новый consent-механизм —
// дисклеймер именно про то, что ФАЙЛ остаётся на устройстве, это
// информационное сообщение, не отдельное действие "разрешить".

import { useState, useEffect, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import { listWorkingMaterials, submitWorkingMaterialVersion } from '../lib/features';
import { extractMaterialText } from '../lib/material-extract';
import { WorkingMaterial } from '../lib/types';
import { haptic } from '../lib/telegram';
import { MaterialChatSection } from './MaterialChatSection';

interface WorkingMaterialsSectionProps {
  projectId: string;
}

export function WorkingMaterialsSection({ projectId }: WorkingMaterialsSectionProps) {
  const [materials, setMaterials] = useState<WorkingMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addingVersionFor, setAddingVersionFor] = useState<string | null>(null);

  const reload = useCallback(() => {
    return listWorkingMaterials(projectId)
      .then(setMaterials)
      .catch(() => setMaterials([]));
  }, [projectId]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>, materialId?: string) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setExtracting(true);
    setError(null);
    try {
      const extracted = await extractMaterialText(file);
      if (extracted.format === 'unsupported') {
        setError('Поддерживаются только .md-файлы и презентации PPTX — текст извлекается на устройстве, файл не передаётся.');
        return;
      }
      setExtracting(false);
      setSubmitting(true);
      await submitWorkingMaterialVersion(projectId, {
        extractedText: extracted.text,
        materialId,
        title: materialId ? undefined : title.trim() || file.name,
      });
      await reload();
      setTitle('');
      setAddingVersionFor(null);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось обработать материал');
    } finally {
      setExtracting(false);
      setSubmitting(false);
    }
  }

  if (loading) return null;

  return (
    <section className="working-materials-section">
      <h3>Материалы для спарринга</h3>
      <p className="conversations-section__hint">
        Сам файл (.md/PPTX) не передаётся на сервер — на устройстве извлекается только текст, дальше уходит только он.
        Критика строится в контексте цели этого проекта, с готовым промптом на правки.
      </p>

      {materials.length > 0 && (
        <ul className="working-materials-section__list">
          {materials.map((m) => {
            const lastVersion = m.versions[m.versions.length - 1];
            return (
              <li key={m.id} className="working-materials-section__item">
                <strong>{m.title}</strong>
                <span className="conversations-section__hint">Версий: {m.versions.length}</span>
                {m.versions.map((v) => (
                  <div key={v.id} className="working-materials-section__version">
                    <span className="steelman-case__label">Версия {v.versionNumber}</span>
                    <span>{v.critique}</span>
                    <span className="working-materials-section__prompt">Промпт на правки: {v.editPrompt}</span>
                  </div>
                ))}
                {addingVersionFor === m.id ? (
                  <label>
                    Загрузить исправленную версию
                    <input type="file" accept=".md,.pptx" onChange={(e) => handleFileSelected(e, m.id)} disabled={extracting || submitting} />
                  </label>
                ) : (
                  <button type="button" onClick={() => setAddingVersionFor(m.id)}>
                    Загрузить исправленную версию
                  </button>
                )}
                {lastVersion && <span className="conversations-section__hint">Последняя правка: v{lastVersion.versionNumber}</span>}
                <MaterialChatSection projectId={projectId} workingMaterialId={m.id} />
              </li>
            );
          })}
        </ul>
      )}

      <div className="conversations-section__add">
        <label>
          Название материала
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: ТЗ для инвестора" />
        </label>
        <label>
          Файл (.md или .pptx)
          <input type="file" accept=".md,.pptx" onChange={(e) => handleFileSelected(e)} disabled={extracting || submitting} />
        </label>
        {extracting && <p className="conversations-section__hint">Извлекаем текст на устройстве…</p>}
        {submitting && <p className="conversations-section__hint">Получаем разбор…</p>}
        {error && <p className="generation-error">{error}</p>}
      </div>
    </section>
  );
}
