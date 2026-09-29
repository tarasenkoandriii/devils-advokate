'use client';

// Пункт [candidate-rights] 2026-09-04 — право, которое продукт обещал и
// не давал.
//
// Текст согласия на преданкете говорил кандидату дословно: «вы можете
// попросить отозвать согласие». Отзыв в продукте существовал — но только
// у РЕКРУТЕРА, за авторизацией, внутри Mini App. У кандидата не было
// ничего: он не пользователь продукта, аккаунта у него нет, и «попросить»
// было некого, кроме того самого человека, от чьих действий он и хотел бы
// отгородиться.
//
// Это не мелочь формулировки. Кандидат — единственный участник, который
// продукт не выбирал: ссылку ему прислали. Все остальные обещания
// продукта («не детектор лжи», «решает человек», «никаких баллов») на
// этом экране соблюдены аккуратно, и на их фоне обещанное и не выданное
// право заметнее вдвойне.
//
// Отдельным компонентом — чтобы его можно было НАРИСОВАТЬ в тесте (урок
// [render-guards]): внутри страницы с загрузкой формы проверить его
// было бы нечем, кроме чтения исходника.

import { useState } from 'react';
import { CandidateRevocation, revokePreQuestionnaireConsent } from '../lib/public-api';

/** Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — состояние
 * «после отзыва» отдельным компонентом, чтобы его можно было НАРИСОВАТЬ
 * в проверке с готовым исходом. Тот же урок [render-guards], что и у
 * самого этого экрана: то, что нельзя нарисовать, проверяется чтением
 * исходника — то есть не проверяется. */
export function CandidateRevocationOutcome({ result, revokedAt }: { result: CandidateRevocation | null; revokedAt: string | null }) {
  return (
    <section className="domain-panel">
      {/* Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25: у
          прежнего отзыва называется дата — она приходит моментом, а
          календарное число считает УСТРОЙСТВО человека, которое одно и
          знает его часовой пояс (правило [server-said-which-day]). */}
      <p className="dtp-status dtp-status--ok" role="status">
        Согласие отозвано{result ? '' : ' ранее'}
        {!result && revokedAt ? `, ${new Date(revokedAt).toLocaleDateString('ru-RU')}` : ''}.
      </p>
      {/* Обе половины обязательны. «Отозвано» без перечня последствий
          человек достраивает в свою пользу и решает, что стёрлось всё. */}
      {result && <p className="dtp-hint">{result.alsoDone}</p>}
      {result && <p className="dtp-status dtp-status--warn">{result.doesNotUndo}</p>}
      {/* «Дошли не до конца» — отдельная строка, а не оттенок внутри
          абзаца: человеку, только что отозвавшему согласие, это самая
          существенная новость. */}
      {result?.depthExhausted && (
        <p className="dtp-status dtp-status--warn" role="alert">
          Цепочка передач оказалась длиннее, чем продукт проходит за один раз: самые дальние копии могли остаться
          непомеченными. Напишите тому, кто прислал ссылку, или в поддержку, чтобы довести отзыв до конца.
        </p>
      )}
      {!result && (
        <p className="dtp-status dtp-status--warn">
          Отзыв запрещает дальнейшую обработку, но не стирает то, что получатель уже прочитал. Полное удаление — по запросу тому, кто прислал ссылку.
        </p>
      )}
    </section>
  );
}

export function CandidateConsentControls({ token, revokedAt }: { token: string; revokedAt: string | null }) {
  const [result, setResult] = useState<CandidateRevocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (result || revokedAt) {
    return <CandidateRevocationOutcome result={result} revokedAt={revokedAt} />;
  }

  return (
    <section className="domain-panel">
      {error && <p role="alert" className="generation-error">{error}</p>}
      {confirming ? (
        <>
          {/* Шаг подтверждения — потому что действие для кандидата
              заметное и одностороннее: обратной кнопки «вернуть
              согласие» у него нет, и делать вид, что есть, нельзя. */}
          <p className="dtp-status dtp-status--warn" role="status">
            {/* Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25:
                было «переданные им дальше ссылки закроются» — обещание,
                которое продукт даёт ДО действия и не всегда может
                сдержать: цепочку копий он проходит на ограниченную
                глубину. Что вышло на самом деле, скажет экран после. */}
            Отозвать согласие? Ваш профиль у получателя будет помечен как отозванный, а ссылки, которыми его передавали дальше, закроются — насколько продукт пройдёт цепочку копий; что получилось, он скажет сразу после. Ответы, которые он уже прочитал, останутся у него — вернуть согласие через эту ссылку будет нельзя.
          </p>
          <div className="entity-form__actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await revokePreQuestionnaireConsent(token));
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Не удалось отозвать согласие');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Отзываем…' : 'Да, отозвать'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Не отзывать</button>
          </div>
        </>
      ) : (
        <>
          <p className="dtp-hint">Согласие на обработку ваших ответов можно отозвать здесь же, по этой ссылке — аккаунт для этого не нужен.</p>
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>Отозвать согласие</button>
        </>
      )}
    </section>
  );
}
