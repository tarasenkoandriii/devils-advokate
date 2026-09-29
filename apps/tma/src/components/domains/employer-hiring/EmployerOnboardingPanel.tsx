'use client';

// Пункт [job-domain-v2] Р-0 — онбординг работодателя: разговор голосом/текстом
// (квиз уже мог сложить сюда ответы — ?c=<conversationId>) → «Извлечь» делает из
// него ВНУТРЕННИЙ бриф и черновики пунктов листа вакансии с цитатами. Конфиг
// работодатель правит руками на вкладке «Вакансия» — источник истины у него
// бриф и подтверждённые пункты, не AI-драфт. До идентификации компании
// извлечение отвечает 409 COMPANY_REQUIRED — экран ведёт на «Компанию».
import { useEffect, useState } from 'react';
import { domainApi } from '../../../lib/domains/api';
import { DomainManifest } from '../../../lib/domains/types';
import { AiErrorNotice } from '../AiErrorNotice';
import { VoiceTextInput } from '../VoiceTextInput';
import { haptic } from '../../../lib/telegram';

export function EmployerOnboardingPanel({ manifest, projectId, conversationId: initial, onExtracted }: { manifest: DomainManifest; projectId: string; conversationId: string | null; onExtracted: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(initial);
  const [answers, setAnswers] = useState<Array<{ id: string; text: string }>>([]);
  const [checklist, setChecklist] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<any | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        let id = conversationId;
        if (!id) { id = (await domainApi.createOnboarding(manifest, projectId)).conversation.id; setConversationId(id); }
        const conv = await domainApi.getOnboarding(manifest, id);
        setAnswers(conv.answers ?? []);
        setChecklist(await domainApi.checklist(manifest, id).catch(() => null));
      } catch (e) { setError(e); }
    })();
  }, [manifest, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (!conversationId || !draft.trim()) return;
    setBusy(true); setError(null);
    try { const a = await domainApi.appendAnswer(manifest, conversationId, draft.trim()); setAnswers((x) => [...x, a]); setDraft(''); haptic('success'); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function extract() {
    if (!conversationId) return;
    setBusy(true); setError(null);
    try { setResult(await domainApi.extract(manifest, conversationId)); haptic('success'); onExtracted(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const companyRequired = (error as any)?.code === 'COMPANY_REQUIRED';

  return (
    <section className="domain-panel">
      <p className="card-section__empty">Расскажите о вакансии своими словами: кого ищете, что важно, какие условия. Всё сказанное станет внутренним брифом и черновиками пунктов листа — с цитатами из ваших слов; подтверждаете вы.</p>
      {companyRequired ? <p className="dtp-status dtp-status--warn">Сначала укажите компанию на вкладке «Компания» — бриф и пункты подписываются её реквизитами.</p> : <AiErrorNotice error={error} onConsentGranted={() => setError(null)} />}
      {checklist && checklist.length > 0 && (
        <details><summary>О чём стоит рассказать</summary><ul>{checklist.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
      )}
      {answers.length > 0 && <ul className="domain-onboarding__answers">{answers.map((a) => <li key={a.id}>{a.text}</li>)}</ul>}
      <VoiceTextInput value={draft} onChange={setDraft} placeholder="Например: нужен менеджер по продажам в B2B, важен опыт холодных звонков, офис в Киеве, оплата 1000–1500…" />
      <div className="entity-form__actions">
        <button type="button" className="secondary" disabled={busy || !draft.trim()} onClick={send}>Добавить</button>
        <button type="button" className="primary" disabled={busy || answers.length === 0} onClick={extract}>{busy ? '…' : 'Извлечь бриф и пункты листа'}</button>
      </div>
      {result && (
        <p className="dtp-status dtp-status--ok">
          Бриф сохранён; черновиков пунктов листа вакансии: {Array.isArray(result.proposedClauses) ? result.proposedClauses.length : 0}. Подтвердите их на вкладке «Лист вакансии» и заполните параметры на вкладке «Вакансия».
        </p>
      )}
    </section>
  );
}
