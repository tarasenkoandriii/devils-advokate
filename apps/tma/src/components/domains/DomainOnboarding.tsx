'use client';

// ТЗ §0 — DomainOnboarding: Q&A по одному ответу (appendAnswer) → «Извлечь»
// (extract) → редактируемый драфт конфига → POST config. История ответов
// читается с backend (фаза A, GET onboarding-conversations/:id) — после
// replay из intake-квиза она уже заполнена.
import { useEffect, useState } from 'react';
import { domainApi } from '../../lib/domains/api';
import { DomainManifest } from '../../lib/domains/types';
import { EntityForm } from './EntityForm';
import { VoiceTextInput } from './VoiceTextInput';
import { haptic } from '../../lib/telegram';

interface Props {
  manifest: DomainManifest;
  projectId: string;
  conversationId: string | null;
  onConfigCreated: (config: Record<string, any>) => void;
}

interface Criterion { text: string; category?: string; isRequired: boolean; orderIndex: number }

export function DomainOnboarding({ manifest, projectId, conversationId: initialConversationId, onConfigCreated }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [answers, setAnswers] = useState<Array<{ id: string; text: string }>>([]);
  const [checklist, setChecklist] = useState<any>(null);
  const [draft, setDraft] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<Record<string, any> | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [category, setCategory] = useState<'REAL_ESTATE' | 'VEHICLE'>('REAL_ESTATE');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let id = conversationId;
        if (!id) {
          const created = await domainApi.createOnboarding(manifest, projectId);
          id = created.conversation.id;
          if (!cancelled) setConversationId(id);
        }
        const data = await domainApi.getOnboarding(manifest, id);
        if (!cancelled) setAnswers(data.answers);
        if (manifest.routes.checklist) {
          const cl = await domainApi.checklist(manifest, id, manifest.id === 'major-purchase' ? { category } : undefined).catch(() => null);
          if (!cancelled) setChecklist(cl);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось открыть онбординг');
      }
    }
    void load();
    return () => { cancelled = true; };
    // ОСТАВЛЕНО ОСОЗНАННО (аудит 2026-09-01, ревизия всех подавлений):
    // эффект ОТКРЫВАЕТ онбординг — при отсутствии conversationId он его
    // создаёт. conversationId в зависимостях означал бы повторный проход
    // сразу после собственного setConversationId, а category — полный
    // перезапуск онбординга при переключении категории (за это отвечает
    // отдельный эффект ниже, он перезапрашивает только чек-лист).
    // Правильный триггер здесь ровно один: смена проекта.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!conversationId || manifest.id !== 'major-purchase') return;
    domainApi.checklist(manifest, conversationId, { category }).then(setChecklist).catch(() => undefined);
    // ОСТАВЛЕНО ОСОЗНАННО (аудит 2026-09-01, ревизия всех подавлений):
    // эффект существует ровно ради смены категории. conversationId и
    // manifest тут — условие применимости, а не триггер: первый чек-лист
    // грузит эффект открытия онбординга выше, и повтор по появлению
    // conversationId был бы вторым тем же запросом подряд.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function send() {
    if (!conversationId || !draft.trim()) return;
    setBusy(true); setError(null);
    try {
      const seg = await domainApi.appendAnswer(manifest, conversationId, draft.trim());
      setAnswers((prev) => [...prev, { id: seg.id, text: seg.text }]);
      setDraft('');
      haptic('light');
      if (manifest.routes.checklist) setChecklist(await domainApi.checklist(manifest, conversationId, manifest.id === 'major-purchase' ? { category } : undefined).catch(() => checklist));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить ответ');
    } finally { setBusy(false); }
  }

  async function extract() {
    if (!conversationId) return;
    setBusy(true); setError(null);
    try {
      const result = await domainApi.extract(manifest, conversationId);
      setExtracted(result);
      if (manifest.hasCriteria && Array.isArray(result.criteria)) {
        setCriteria(result.criteria.map((c: any, i: number) => ({ text: c.text ?? '', category: c.category, isRequired: Boolean(c.isRequired), orderIndex: c.orderIndex ?? i })));
      }
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'AI не смог извлечь конфиг — добавьте ответов и попробуйте снова');
    } finally { setBusy(false); }
  }

  async function confirm(values: Record<string, unknown>) {
    const body: Record<string, unknown> = { ...extracted, ...values };
    if (manifest.hasCriteria) body.criteria = criteria.map((c, i) => ({ ...c, orderIndex: i }));
    const config = await domainApi.createConfig(manifest, projectId, body);
    onConfigCreated(config);
  }

  return (
    <section className="domain-onboarding">
      <h2>Онбординг · {manifest.title}</h2>
      {error && <p className="generation-error">{error}</p>}

      {manifest.id === 'major-purchase' && (
        <label className="entity-form__field"><span>Что покупаете (для чек-листа вопросов)</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as any)}><option value="REAL_ESTATE">Недвижимость</option><option value="VEHICLE">Транспорт</option></select>
        </label>
      )}
      {checklist && (
        <div className="domain-onboarding__checklist">
          <h3>Что ещё стоит рассказать</h3>
          {Array.isArray(checklist) && checklist.every((x: unknown) => typeof x === 'string')
            ? <ul className="dtp-criteria-group">{(checklist as string[]).map((item, i) => <li key={i}>{item}</li>)}</ul>
            : <pre className="domain-json">{typeof checklist === 'string' ? checklist : JSON.stringify(checklist, null, 2)}</pre>}
        </div>
      )}

      <ol className="domain-onboarding__answers">
        {answers.map((a) => <li key={a.id}>{a.text}</li>)}
      </ol>
      {answers.length === 0 && <p className="card-section__empty">Расскажите о ситуации своими словами — по одному сообщению. Голосом или текстом.</p>}

      {!extracted && (
        <>
          <VoiceTextInput value={draft} onChange={setDraft} disabled={busy} placeholder="Ваш ответ…" />
          <div className="entity-form__actions">
            <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={send}>Добавить</button>
            <button type="button" className="secondary" disabled={busy || answers.length === 0} onClick={extract}>Извлечь конфиг из ответов</button>
          </div>
        </>
      )}

      {extracted && (
        <div className="domain-onboarding__draft">
          <h3>Проверьте, что понял AI</h3>
          <p className="card-section__empty">Это предложение, не решение — правьте перед подтверждением.</p>
          {manifest.hasCriteria && (
            <div className="domain-criteria">
              <h4>Критерии</h4>
              {criteria.map((c, i) => (
                <div key={i} className="domain-criteria__row">
                  <input value={c.text} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  {manifest.criteriaCategories && (
                    <select value={c.category ?? 'OTHER'} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))}>
                      {manifest.criteriaCategories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  )}
                  <label><input type="checkbox" checked={c.isRequired} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, isRequired: e.target.checked } : x)))} /> обязательный</label>
                  <button type="button" className="secondary" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="secondary" onClick={() => setCriteria([...criteria, { text: '', category: manifest.criteriaCategories?.[0], isRequired: false, orderIndex: criteria.length }])}>+ критерий</button>
            </div>
          )}
          <EntityForm fields={manifest.configFields} initial={extracted} submitLabel="Подтвердить конфиг" onSubmit={confirm} onCancel={() => setExtracted(null)} />
        </div>
      )}
    </section>
  );
}
