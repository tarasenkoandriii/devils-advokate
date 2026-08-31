'use client';

// Пункт [admin-panel]: devils-advocate-admin-panel-tz.md §3, "prompts/page.tsx
// — список PromptVersion по promptId". Честная граница API-контракта
// (devils-advocate-prompt-framework-tz.md §5.1) — нет эндпоинта
// "список всех существующих promptId", только GET /admin/prompts/:promptId
// для уже известного значения. promptId — тот же строковый неймспейс,
// что taskType в телеметрии (35 сервисов проекта читают активную
// версию по promptId=taskType своего вызова) — оператор находит нужные
// значения через вкладку «Телеметрия», не гадает их здесь.

import { useState } from 'react';
import Link from 'next/link';
import { listPromptVersions, getActivePromptVersion, createPromptDraft } from '../../lib/endpoints';
import type { PromptVersion } from '../../lib/types';

const STATUS_BADGE: Record<PromptVersion['status'], string> = {
  DRAFT: 'badge-pending',
  TESTING: 'badge-pending',
  ACTIVE: 'badge-ok',
  DEPRECATED: 'badge-bad',
};

export default function PromptsPage() {
  const [promptId, setPromptId] = useState('');
  const [versions, setVersions] = useState<PromptVersion[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [draftVersion, setDraftVersion] = useState('');
  const [draftTemplate, setDraftTemplate] = useState('');
  const [draftChangelog, setDraftChangelog] = useState('');
  const [creating, setCreating] = useState(false);

  async function search() {
    if (!promptId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [list, active] = await Promise.all([
        listPromptVersions(promptId.trim()),
        getActivePromptVersion(promptId.trim()),
      ]);
      setVersions(list);
      setActiveId(active?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить версии');
      setVersions(null);
    } finally {
      setLoading(false);
    }
  }

  async function submitDraft() {
    if (!promptId.trim() || !draftVersion.trim() || !draftTemplate.trim()) return;
    setCreating(true);
    try {
      await createPromptDraft(promptId.trim(), draftVersion.trim(), draftTemplate, draftChangelog || undefined);
      setDraftVersion('');
      setDraftTemplate('');
      setDraftChangelog('');
      setShowCreate(false);
      await search();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Промпты</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Registry + Evaluation Gates (devils-advocate-prompt-framework-tz.md). Введите promptId — тот
        же taskType, что виден на вкладке «Телеметрия» по конкретной фиче.
      </p>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12 }}>
        <input
          placeholder="promptId, например discrepancy-detector"
          style={{ flex: 1 }}
          value={promptId}
          onChange={(e) => setPromptId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button className="btn btn-primary" onClick={search} disabled={loading}>
          {loading ? 'Ищем…' : 'Найти'}
        </button>
        <button className="btn" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Отменить' : 'Новый черновик'}
        </button>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, marginBottom: 12 }}>Новая версия (черновик)</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              placeholder="Версия, например v2"
              value={draftVersion}
              onChange={(e) => setDraftVersion(e.target.value)}
            />
            <textarea
              placeholder="Текст системного промпта"
              rows={6}
              value={draftTemplate}
              onChange={(e) => setDraftTemplate(e.target.value)}
            />
            <input
              placeholder="Changelog (необязательно)"
              value={draftChangelog}
              onChange={(e) => setDraftChangelog(e.target.value)}
            />
            <button className="btn btn-primary" onClick={submitDraft} disabled={creating}>
              {creating ? 'Создаём…' : 'Создать draft'}
            </button>
          </div>
        </div>
      )}

      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}

      {versions && versions.length === 0 && (
        <p className="muted">Версий для promptId=&quot;{promptId}&quot; пока нет.</p>
      )}

      {versions && versions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Версия</th>
              <th>Статус</th>
              <th>Changelog</th>
              <th>Создана</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/prompts/${v.id}?promptId=${encodeURIComponent(promptId.trim())}`}>{v.version}</Link>
                  {v.id === activeId && (
                    <span className="badge badge-ok" style={{ marginLeft: 8 }}>
                      текущая активная
                    </span>
                  )}
                </td>
                <td>
                  <span className={`badge ${STATUS_BADGE[v.status]}`}>{v.status}</span>
                </td>
                <td className="muted">{v.changelog ?? '—'}</td>
                <td className="muted">{new Date(v.createdAt).toLocaleString('ru-RU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
