// Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26.
//
// Утверждение пункта — «продукт не спрашивает биометрическое согласие и
// не включает микрофон, пока не знает, что сможет посчитать отпечаток».
// Это утверждение о ПОРЯДКЕ ВЫЗОВОВ, и проверяется он вызовом: заглушки
// записывают, кого спросили и в каком порядке.
//
// Отдельно рисуется честный текст вместо кнопки — потому что «не
// спрашиваем и не записываем» человек должен ПРОЧИТАТЬ, а не догадаться
// по отсутствию кнопки.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЕНО, И ЭТО НАЗВАНО ЧЕСТНО. Из трёх звеньев —
// решение (`expandStep`/`enrollmentStep`), разметка (`EnrollmentBody`) и
// одна строка обработчика, кладущая решение в состояние, — проверены
// первые два. Третье проверить нечем: обработчик срабатывает по нажатию,
// а собственный раннер рисует разметку статически и клика не делает.
// Мутация «положить в состояние не то, что вернуло решение» это
// переживает. Шов сузили насколько можно — состояние носит свой текст
// одним значением, так что потерять текст отдельно от состояния уже
// нельзя, — но само присваивание остаётся непокрытым. Закрыть это
// значит завести в проекте DOM-рендерер (jsdom + react-dom/client);
// это отдельное решение, а не приписка в этой сверке, и оно записано в
// `TODO.md`.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  enrollmentStep,
  expandStep,
  voiceEmbeddingAvailability,
  resetVoiceEmbeddingAvailability,
} from '../lib/voice-embedding';
import { EnrollmentBody, VoiceEnrollmentUnavailable } from '../components/VoiceEnrollmentSection';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const TMA = join(__dirname, '..', '..');
const REPO = join(TMA, '..', '..');

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: заглушки доступности действительно меняют ответ', async () => {
    resetVoiceEmbeddingAvailability();
    const yes = await voiceEmbeddingAvailability('/m.onnx', async () => ({}), async () => ({ ok: true }));
    assert(yes.available, 'при наличии и модуля, и модели возможность не признана — дальнейшие проверки ничего не значат');
    resetVoiceEmbeddingAvailability();
    const no = await voiceEmbeddingAvailability('/m.onnx', async () => null, async () => ({ ok: true }));
    assert(!no.available, 'при отсутствии модуля возможность всё равно признана');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: пока посчитать отпечаток нечем — согласие НЕ спрашивают', async () => {
    const asked: string[] = [];
    const next = await enrollmentStep({
      availability: async () => {
        asked.push('availability');
        return { available: false, why: 'модуля нет в сборке' };
      },
      hasBiometricConsent: async () => {
        asked.push('consent');
        return true;
      },
    });
    assert(next.step === 'unavailable', `шаг не «недоступно»: ${next.step}`);
    // Порядок и есть суть: о согласии речи не заходит вовсе.
    assert(asked.join(',') === 'availability', `спросили лишнее или не в том порядке: ${asked.join(',')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: когда посчитать есть чем — согласие спрашивают, и только потом пишут', async () => {
    // Обратная сторона: правило не должно запрещать саму фичу — иначе
    // предыдущий тест проходил бы от того, что не работает ничего.
    const asked: string[] = [];
    const needConsent = await enrollmentStep({
      availability: async () => {
        asked.push('availability');
        return { available: true, why: '' };
      },
      hasBiometricConsent: async () => {
        asked.push('consent');
        return false;
      },
    });
    assert(needConsent.step === 'need-consent', `без согласия шаг не «спросить согласие»: ${needConsent.step}`);
    assert(asked.join(',') === 'availability,consent', `порядок нарушен: ${asked.join(',')}`);

    const withConsent = await enrollmentStep({
      availability: async () => ({ available: true, why: '' }),
      hasBiometricConsent: async () => true,
    });
    assert(withConsent.step === 'record', `с согласием шаг не «записывать»: ${withConsent.step}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: причина недоступности называет, ЧЕГО не хватает', async () => {
    resetVoiceEmbeddingAvailability();
    const noModule = await voiceEmbeddingAvailability('/models/x.onnx', async () => null, async () => ({ ok: true }));
    assert(/модуль/i.test(noModule.why), `причина не про модуль: ${noModule.why}`);
    resetVoiceEmbeddingAvailability();
    const noModel = await voiceEmbeddingAvailability('/models/x.onnx', async () => ({}), async () => ({ ok: false }));
    assert(noModel.why.includes('/models/x.onnx'), `причина не называет адрес модели: ${noModel.why}`);
  }],

  ['обратная проба: сбой запроса модели читается как «модели нет», а не как «есть»', async () => {
    resetVoiceEmbeddingAvailability();
    const broken = await voiceEmbeddingAvailability('/m.onnx', async () => ({}), async () => {
      throw new Error('сеть');
    });
    assert(!broken.available, 'сбой проверки модели выдан за наличие модели');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: человек ЧИТАЕТ, что согласия не просят и запись не делают', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceEnrollmentUnavailable, { why: 'модуля нет в этой сборке' }),
    );
    assert(html.includes('модуля нет в этой сборке'), 'причина не показана');
    assert(/согласие на биометрию не спрашиваем/i.test(html), 'не сказано, что согласие не спрашивают');
    assert(/запись не делаем/i.test(html), 'не сказано, что запись не делают');
    // И что человек теряет — тоже сказано: иначе «не работает» читается
    // как «что-то важное сломано».
    assert(/разбор работает как обычно/i.test(html), 'не сказано, чем это ограничивает разбор');
    assert(!/Записать образец/i.test(html), 'кнопка записи осталась на недоступном экране');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: при открытии раздела возможность проверяется ПЕРВОЙ', async () => {
    // Мутация «игнорировать проверку при открытии» пережила первую
    // версию: проверялась чистая функция, а не место её применения.
    const asked: string[] = [];
    const next = await expandStep({
      availability: async () => {
        asked.push('availability');
        return { available: false, why: 'модуля нет' };
      },
      status: async () => {
        asked.push('status');
        return { enrolled: true };
      },
    });
    assert(next.state === 'unavailable', `при открытии показано не «недоступно»: ${next.state}`);
    // Даже статус регистрации не спрашивается: нечего и спрашивать.
    assert(asked.join(',') === 'availability', `спрошено лишнее: ${asked.join(',')}`);

    // Обратная сторона: когда возможность есть — статус спрашивается.
    const ok = await expandStep({
      availability: async () => ({ available: true, why: '' }),
      status: async () => ({ enrolled: true }),
    });
    assert(ok.state === 'enrolled', `при готовности и регистрации состояние не «зарегистрирован»: ${ok.state}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: раздел РИСУЕТ честный текст вместо кнопки, а не просто прячет её', () => {
    // Мутация «убрать честный текст с экрана» пережила первую версию:
    // рисовался только отдельный компонент текста, но не раздел.
    // Состояние приходит вместе со своим текстом одним значением:
    // передать состояние и забыть причину теперь нельзя (мутация
    // «потерять причину по дороге» жила ровно на этом шве).
    const body = (view: unknown) =>
      renderToStaticMarkup(
        createElement(EnrollmentBody as never, {
          view,
          onStartRecording: () => undefined,
          onRevoke: () => undefined,
          onConsentGranted: () => undefined,
          onConsentCancel: () => undefined,
        }),
      );
    const unavailable = body({ state: 'unavailable', why: 'модуля нет в этой сборке' });
    assert(unavailable.includes('модуля нет в этой сборке'), 'раздел не показал причину недоступности');
    assert(/согласие на биометрию не спрашиваем/i.test(unavailable), 'раздел не сказал, что согласия не просит');
    assert(!/Записать образец/i.test(unavailable), 'кнопка записи осталась на недоступном экране');

    // Обратная проба: в обычном состоянии кнопка есть — иначе проверка
    // проходила бы от того, что кнопки нет никогда.
    assert(/Записать образец/i.test(body({ state: 'idle' })), 'в обычном состоянии кнопка записи пропала');
    // И текст ошибки тоже носит само состояние.
    assert(body({ state: 'error', message: 'микрофон недоступен' }).includes('микрофон недоступен'),
      'текст ошибки не дошёл до разметки');
  }],

  ['МЕРА: в этой сборке фича действительно недоступна — и это записано числом', () => {
    // Пункт держится на факте: ни модуля в зависимостях, ни файла модели.
    // Если однажды и то и другое появится, этот тест покраснеет — и
    // тогда надо проверить API живьём, а не считать, что заработало.
    const pkgs = ['apps/tma/package.json', 'apps/api/package.json', 'package.json'];
    const withSherpa = pkgs.filter((rel) => readFileSync(join(REPO, rel), 'utf8').includes('sherpa-onnx-wasm'));
    assert(withSherpa.length === 0, `модуль появился в зависимостях: ${withSherpa.join(', ')} — проверьте API живьём`);
    assert(!existsSync(join(TMA, 'public', 'models', 'speaker-embedding.onnx')), 'файл модели появился — проверьте API живьём');
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
