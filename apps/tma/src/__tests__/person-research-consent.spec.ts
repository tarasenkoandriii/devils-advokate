// Пункт [consent-that-could-not-be-given] 2026-09-24 — экран согласия на
// разбор о человеке проверяется ВЫЗОВОМ и РАЗМЕТКОЙ, а не чтением
// исходника: «просит именно этот тип» — утверждение о поведении, и
// проверяться оно должно поведением.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiRequestError } from '../lib/api';
import {
  PersonResearchConsent,
  grantPersonResearchConsent,
  isPersonResearchConsentNeeded,
  PERSON_RESEARCH_CONSENT_VERSION,
  consentOrError,
} from '../components/PersonResearchConsent';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: экран просит ИМЕННО согласие на разбор о человеке', async () => {
    const calls: Array<{ consentType: string; version: string; source: string }> = [];
    await grantPersonResearchConsent('spec', async (params: any) => {
      calls.push(params);
      return {} as any;
    });
    assert(calls.length === 1, 'согласие не запрошено вовсе');
    assert(calls[0].consentType === 'PERSON_RESEARCH', `запрошен другой тип: ${calls[0].consentType}`);
    assert(calls[0].version === PERSON_RESEARCH_CONSENT_VERSION, 'версия текста согласия не та, что объявлена');
    assert(calls[0].source === 'spec', 'откуда спросили — не передано');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отказ по согласию опознаётся по коду и типу, а не по тексту', () => {
    const real = new ApiRequestError('Для этого действия нужно ваше согласие', 403, 'CONSENT_REQUIRED', {
      consentType: 'PERSON_RESEARCH',
    });
    assert(isPersonResearchConsentNeeded(real), 'настоящий отказ не опознан');

    // Ближние промахи: другой тип согласия и другой код — оба НЕ наши.
    const otherType = new ApiRequestError('текст', 403, 'CONSENT_REQUIRED', { consentType: 'EXTERNAL_AI' });
    const otherCode = new ApiRequestError('текст', 403, 'COMPANY_REQUIRED', { consentType: 'PERSON_RESEARCH' });
    assert(!isPersonResearchConsentNeeded(otherType), 'чужое согласие принято за своё');
    assert(!isPersonResearchConsentNeeded(otherCode), 'чужой код принят за свой');
    assert(!isPersonResearchConsentNeeded(new Error('Для этого действия нужно ваше согласие')), 'опознание по тексту');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отказ по согласию ведёт к вопросу, а не к сообщению об ошибке', () => {
    // Без этого разделения человек упирался бы в тупик: продукт
    // отказывает и не даёт способа разрешить.
    const refusal = new ApiRequestError('текст', 403, 'CONSENT_REQUIRED', { consentType: 'PERSON_RESEARCH' });
    const decided = consentOrError(refusal, 'запасной текст');
    assert('consentNeeded' in decided, 'отказ по согласию показан как ошибка — тупик');

    // Обратная сторона: обычный сбой остаётся сбоем и не превращается
    // в вопрос о согласии, иначе экран предлагал бы разрешить то, что
    // и так разрешено.
    const failure = consentOrError(new Error('Сеть недоступна'), 'запасной текст');
    assert(!('consentNeeded' in failure), 'обычный сбой принят за отказ по согласию');
    assert((failure as { message: string }).message === 'Сеть недоступна', 'текст сбоя потерян');

    // И пустое сообщение не оставляет человека без слов.
    const empty = consentOrError(new Error('   '), 'запасной текст');
    assert((empty as { message: string }).message === 'запасной текст', 'пустой текст сбоя не заменён');
  }],

  ['экран называет предмет прямо: разбор о человеке, который согласия не давал', () => {
    const html = renderToStaticMarkup(createElement(PersonResearchConsent, { source: 'spec', onGranted: () => {} }));
    assert(/О ЧЕЛОВЕКЕ/.test(html), 'предмет не назван');
    assert(/согласия не давал/.test(html), 'не сказано, что сам человек согласия не давал');
    assert(/никого не разыскивает/.test(html), 'не сказано, чего продукт НЕ делает');
    assert(/<button/.test(html), 'кнопки, которой дают согласие, нет');
  }],

  ['экран не обещает того, чего отзыв не делает', () => {
    const html = renderToStaticMarkup(createElement(PersonResearchConsent, { source: 'spec', onGranted: () => {} }));
    // То же, что записано в реестре последствий отзыва на сервере:
    // уже собранное остаётся. Обещать обратное на экране согласия
    // значило бы соврать в единственном месте, где врать нельзя.
    assert(/уже собранные сведения останутся|Уже собранные сведения/i.test(html), 'о судьбе уже собранного умолчали');
  }],
];

void (async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`✗ ${name}: ${(e as Error).message}`);
    }
  }
  if (failed > 0) process.exit(1);
})();
