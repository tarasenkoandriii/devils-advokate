'use client';

// Пункт [job-domain-v2] А-2 — публичная преданкета кандидата. Открывается по
// ссылке из Telegram (start_param `preq_<token>`) или в обычном браузере —
// кандидат НЕ пользователь продукта, авторизации нет, поэтому клиент публичный
// (без initData). Ответы принимаются только с двумя согласиями: уведомление об
// AI и передача ответов в профиль у этой компании/агентства. Ответы не
// оцениваются числом и не сравниваются между кандидатами.
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getPreQuestionnaire, submitPreQuestionnaire, PreQuestionnaireForm } from '../../../lib/public-api';
import { CandidateConsentControls } from '../../../components/CandidateConsentControls';

export default function PreQuestionnairePage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<PreQuestionnaireForm | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [aiNotice, setAiNotice] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ answers: number; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPreQuestionnaire(token).then(setForm).catch((e) => setError(e instanceof Error ? e.message : 'Ссылка недействительна'));
  }, [token]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await submitPreQuestionnaire(token, {
        aiNoticeAccepted: aiNotice,
        transferConsentAccepted: transfer,
        answers: Object.entries(answers).filter(([, t]) => t.trim()).map(([questionId, text]) => ({ questionId, text })),
      });
      setDone({ answers: r.answers, note: r.note });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить');
    } finally { setBusy(false); }
  }

  return (
    <main className="page">
      <h1>Анкета кандидата</h1>
      {error && <p role="alert" className="generation-error">{error}</p>}
      {!form && !error && <p>Загрузка…</p>}
      {form && (
        <>
          <p className="dtp-muted">{form.company ? `${form.company} · ` : ''}{form.jobTitle ?? 'вакансия'}{form.expiresAt ? ` · ссылка действует до ${new Date(form.expiresAt).toLocaleDateString('ru-RU')}` : ''}</p>
          {form.answered || done ? (
            <section className="domain-panel">
              <p className="dtp-status dtp-status--ok">Ответы отправлены{done ? ` (${done.answers})` : ''}. Спасибо!</p>
              <p className="dtp-hint">{done?.note ?? 'Ответы не оцениваются числом и не сравниваются между кандидатами.'}</p>
              {/* [candidate-rights] 2026-09-04: право, обещанное в тексте
                  согласия, теперь есть на том же экране — кандидату не
                  нужен ни аккаунт, ни просьба к получателю. */}
              <CandidateConsentControls token={token} revokedAt={form.consentRevokedAt} />
            </section>
          ) : (
            <section className="domain-panel">
              <p className="card-section__empty">Ответьте своими словами на вопросы ниже — как есть, без «правильных ответов». Ваши ответы прочитает человек; AI-ассистент лишь предложит ему, какие пункты анкеты ваши слова закрывают.</p>
              {form.questions.length === 0 && <p className="card-section__empty">В анкете пока нет вопросов — напишите тому, кто прислал ссылку.</p>}
              {form.questions.map((q, i) => (
                <div key={q.id} className="entity-form__field">
                  <label>{i + 1}. {q.text}<br />
                    <textarea rows={3} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  </label>
                </div>
              ))}
              <div className="consent-gate">
                <label><input type="checkbox" checked={aiNotice} onChange={(e) => setAiNotice(e.target.checked)} /> {form.consents.aiNotice}</label><br />
                <label><input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} /> {form.consents.transfer}</label>
              </div>
              <button type="button" className="primary" disabled={busy || !aiNotice || !transfer || !Object.values(answers).some((t) => t.trim())} onClick={submit}>{busy ? 'Отправляем…' : 'Отправить ответы'}</button>
              {(!aiNotice || !transfer) && <p className="dtp-muted">Без обоих согласий ответы не отправляются — это не формальность: без них мы не имеем права хранить ваши ответы.</p>}
            </section>
          )}
        </>
      )}
    </main>
  );
}
