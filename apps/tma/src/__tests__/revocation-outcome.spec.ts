// Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — экран после
// отзыва согласия кандидатом.
//
// Сервер считал, что цепочку копий он прошёл НЕ ДО КОНЦА
// (`depthExhausted`), и отдавал это клиенту. Ни тип клиента, ни экран об
// этом не знали: человек читал «копии помечены отозванными» — и всё.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidateRevocationOutcome } from '../components/CandidateConsentControls';
import type { CandidateRevocation } from '../lib/public-api';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const base: CandidateRevocation = {
  consentRevokedAt: '2026-09-25T10:00:00.000Z',
  alreadyRevoked: false,
  sharesRevoked: 3,
  copiesRevoked: 2,
  depthExhausted: false,
  alsoDone: 'Ваш профиль у получателя помечен как отозванный; закрыто 3 ссылки; 2 копии помечены отозванными.',
  doesNotUndo: 'Ответы, которые вы уже отправили, у получателя останутся.',
};

const html = (result: CandidateRevocation | null, revokedAt: string | null = null) =>
  renderToStaticMarkup(createElement(CandidateRevocationOutcome, { result, revokedAt }));

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: «дошли не до конца» сказано отдельной строкой и произнесено вслух', () => {
    const out = html({ ...base, depthExhausted: true });
    assert(/длиннее, чем продукт проходит/.test(out), `о недойденной цепочке молчат: ${out}`);
    const alert = /<p[^>]*role="alert"[^>]*>([\s\S]*?)<\/p>/.exec(out);
    assert(alert !== null, `предупреждение не в живой области: ${out}`);
    assert(/непомеченными/.test(alert![1]), `в живой области не то предупреждение: ${out}`);
    // И сказано, что делать дальше: предупреждение без выхода — тупик.
    assert(/поддержку|приславшему|прислал ссылку/.test(out), `не сказано, что делать: ${out}`);
  }],

  ['ОБРАТНАЯ ПРОБА: цепочка пройдена целиком — лишнего предупреждения нет', () => {
    // Предупреждение, стоящее всегда, перестаёт что-либо значить.
    const out = html({ ...base, depthExhausted: false });
    assert(!/длиннее, чем продукт проходит/.test(out), `предупреждение стоит всегда: ${out}`);
    assert(!/role="alert"/.test(out), `живая область занята впустую: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: что именно сделано, приходит с сервера и показывается', () => {
    const out = html(base);
    assert(/закрыто 3 ссылки/.test(out), `числа исхода не показаны: ${out}`);
    assert(/2 копии/.test(out), `копии не названы: ${out}`);
    assert(/у получателя останутся/.test(out), `не сказано, чего отзыв не отменяет: ${out}`);
  }],

  ['состояние «отозвано ранее» отличимо от только что сделанного отзыва', () => {
    const out = html(null, '2026-09-01T10:00:00.000Z');
    assert(/отозвано ранее/.test(out), `не отличили прежний отзыв от нового: ${out}`);
    assert(!/role="alert"/.test(out), `предупреждение о глубине без исхода: ${out}`);
  }],
];

let failed = 0;
for (const [name, fn] of scenarios) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}
if (failed > 0) process.exit(1);
