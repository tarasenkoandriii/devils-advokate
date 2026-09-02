'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import {
  listPromptVersions,
  updatePromptDraft,
  promoteToTesting,
  promoteToActive,
  rollbackPrompt,
  createEvaluationDataset,
  addEvaluationCases,
  runEvaluation,
  getEvaluationRun,
} from '../../../lib/endpoints';
import { ApiRequestError } from '../../../lib/admin-api';
import type { PromptVersion, EvaluationRun } from '../../../lib/types';

function PromptDetailInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const promptId = searchParams.get('promptId') ?? '';
  const versionId = params.id;

  const [version, setVersion] = useState<PromptVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [template, setTemplate] = useState('');
  const [changelog, setChangelog] = useState('');

  const [datasetName, setDatasetName] = useState('');
  const [datasetVersion, setDatasetVersion] = useState('v1');
  const [casesJson, setCasesJson] = useState('[]');
  const [run, setRun] = useState<EvaluationRun | null>(null);

  const load = useCallback(async () => {
    if (!promptId) {
      setError('В URL отсутствует promptId — вернитесь на список промптов и откройте версию оттуда.');
      return;
    }
    try {
      const versions = await listPromptVersions(promptId);
      const found = versions.find((v) => v.id === versionId);
      if (!found) {
        setError(`Версия ${versionId} не найдена среди версий promptId="${promptId}"`);
        return;
      }
      setVersion(found);
      setTemplate(found.template);
      setChangelog(found.changelog ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить версию');
    }
  }, [versionId, promptId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft() {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await updatePromptDraft(versionId, { template, changelog });
      setVersion(updated);
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  async function doPromoteToTesting() {
    setBusy(true);
    setActionError(null);
    try {
      setVersion(await promoteToTesting(versionId));
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Не удалось перевести в testing');
    } finally {
      setBusy(false);
    }
  }

  async function doPromoteToActive() {
    setBusy(true);
    setActionError(null);
    try {
      setVersion(await promoteToActive(versionId));
    } catch (err) {
      // ТЗ §5.1: 403 с указанием, какой конкретно порог не пройден —
      // показываем сообщение сервера как есть, не переформулируем.
      setActionError(err instanceof ApiRequestError ? err.message : 'Не удалось активировать');
    } finally {
      setBusy(false);
    }
  }

  async function doRollback() {
    if (!promptId) return;
    setBusy(true);
    setActionError(null);
    try {
      await rollbackPrompt(promptId);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Не удалось откатить');
    } finally {
      setBusy(false);
    }
  }

  async function runEvaluationFlow() {
    setBusy(true);
    setActionError(null);
    try {
      let cases: Array<{ input: string; expectedOutput?: unknown; caseType: 'classification' | 'structural' }>;
      try {
        cases = JSON.parse(casesJson);
      } catch {
        throw new Error('Кейсы должны быть валидным JSON-массивом — см. подсказку под полем');
      }
      const dataset = await createEvaluationDataset(datasetName, datasetVersion);
      await addEvaluationCases(dataset.id, cases);
      const createdRun = await runEvaluation(versionId, dataset.id);
      setRun(createdRun);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось запустить evaluation');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page"><p style={{ color: 'var(--signal-critical)' }}>{error}</p></div>;
  if (!version) return <div className="page"><p className="muted">Загрузка…</p></div>;

  const isDraft = version.status === 'DRAFT';
  const isTesting = version.status === 'TESTING';

  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>
        {version.promptId} · {version.version}
      </h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Статус: <span className="badge badge-pending">{version.status}</span>
      </p>

      {actionError && <p style={{ color: 'var(--signal-critical)', marginBottom: 16 }}>{actionError}</p>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>Текст промпта</h2>
        <textarea
          rows={10}
          style={{ width: '100%' }}
          value={template}
          disabled={!isDraft}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <input
          style={{ width: '100%', marginTop: 10 }}
          placeholder="Changelog"
          value={changelog}
          disabled={!isDraft}
          onChange={(e) => setChangelog(e.target.value)}
        />
        {!isDraft && (
          <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Правка запрещена после перехода в testing (ТЗ §5.1) — версия, уже проходящая оценку, не
            должна тихо измениться под тем же id.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {isDraft && (
            <>
              <button className="btn" onClick={saveDraft} disabled={busy}>
                Сохранить черновик
              </button>
              <button className="btn btn-primary" onClick={doPromoteToTesting} disabled={busy}>
                Перевести в testing
              </button>
            </>
          )}
          {isTesting && (
            <button className="btn btn-primary" onClick={doPromoteToActive} disabled={busy}>
              Активировать (promote-to-active)
            </button>
          )}
          <button className="btn btn-danger" onClick={doRollback} disabled={busy}>
            Откатить promptId на предыдущую активную
          </button>
        </div>
      </div>

      {isTesting && (
        <div className="card">
          <h2 style={{ fontSize: 14, marginBottom: 12 }}>Запустить evaluation</h2>
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Классификационный gate — минимум 40 кейсов, caseType &quot;classification&quot;, каждый
            {' '}<code>{'{ input, expectedOutput: { label }, caseType: "classification" }'}</code>. Структурный
            gate — caseType &quot;structural&quot;, <code>expectedOutput</code> не используется.
          </p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <input placeholder="Название датасета" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
            <input placeholder="Версия датасета" value={datasetVersion} onChange={(e) => setDatasetVersion(e.target.value)} />
          </div>
          <textarea
            rows={6}
            style={{ width: '100%' }}
            value={casesJson}
            onChange={(e) => setCasesJson(e.target.value)}
          />
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={runEvaluationFlow} disabled={busy}>
            {busy ? 'Выполняется…' : 'Создать датасет и прогнать'}
          </button>

          {run && (
            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>
                Прогон {run.id} · <span className="muted">{run.status}</span>
              </h3>
              {run.releaseGate && (
                <p style={{ marginBottom: 10 }}>
                  Gate:{' '}
                  <span className={`badge ${run.releaseGate.passed ? 'badge-ok' : 'badge-bad'}`}>
                    {run.releaseGate.passed ? 'пройден' : 'не пройден'}
                  </span>
                </p>
              )}
              {run.results && run.results.length > 0 && (
                <table style={{ marginBottom: 16 }}>
                  <thead>
                    <tr>
                      <th>Метрика</th>
                      <th>Значение</th>
                      <th>Порог пройден</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.results.map((r) => (
                      <tr key={r.id}>
                        <td>{r.evaluationMetric?.name ?? '—'}</td>
                        <td>{r.value.toFixed(4)}</td>
                        <td>
                          <span className={`badge ${r.passed ? 'badge-ok' : 'badge-bad'}`}>
                            {r.passed ? 'да' : 'нет'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {run.failedCases && run.failedCases.length > 0 && (
                <>
                  <h4 style={{ fontSize: 12, marginBottom: 6 }} className="muted">
                    Провалившиеся кейсы ({run.failedCases.length})
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {run.failedCases.map((c) => (
                      <li key={c.id}>
                        {c.actualOutput} {c.note && <span className="muted">— {c.note}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button
                className="btn"
                style={{ marginTop: 12 }}
                onClick={async () => setRun(await getEvaluationRun(run.id))}
              >
                Обновить статус прогона
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PromptDetailPage() {
  return (
    <Suspense fallback={<div className="page"><p className="muted">Загрузка…</p></div>}>
      <PromptDetailInner />
    </Suspense>
  );
}
