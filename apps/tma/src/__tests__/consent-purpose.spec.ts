// Сверка 2026-09-05, экранная половина — слова, под которыми человек
// подписался.
//
// НАЙДЕННОЕ. Экран согласия на геолокацию говорил одну фразу на все
// случаи: «Координаты никогда не сохраняются — только разовое
// использование для каждого запроса». Для трёх применений, ради
// которых он написан, это правда. Той же записью согласия открывались
// ещё два, где координаты остаются навсегда, — и фраза становилась
// ложью, не изменившись ни на букву.
//
// ДВЕ ДВЕРИ К ОДНОМУ СОГЛАСИЮ. Вторая — `window.confirm` в разделе
// крупной покупки: «нужно согласие на обработку геолокации» и ни слова
// о том, что координаты осмотра сохранятся в карточке варианта. Один и
// тот же тип согласия, два разных текста, оба неполные.
//
// У ГЕОМЕТКИ НА ДОКАЗАТЕЛЬСТВЕ ДВЕРИ НЕ БЫЛО ВОВСЕ. Сервер согласия
// требовал, спросить его на этом экране было негде — оно приезжало с
// экрана погоды. То есть человек соглашался на прогноз, а получал
// координаты в материале, который собирается кому-то предъявлять.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { LOCATION_PURPOSES, LOCATION_PURPOSE_SPECS, locationConsentText, locationPurposeSpec } from '../lib/location-purposes';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь: в этом файле прежние формулировки процитированы
 * в шапке, и проверка на текст поймала бы их. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function screens(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) out.push(full);
    }
  })(SRC);
  return out;
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: текст согласия говорит правду про КАЖДЫЙ набор применений', () => {
    const transient = locationConsentText([LOCATION_PURPOSES.WEATHER, LOCATION_PURPOSES.VENUE_SEARCH]);
    assert(/не сохраняются/.test(transient), 'о разовом использовании больше не сказано');
    assert(!/СОХРАНЯЮТСЯ/.test(transient), 'разовому применению приписано сохранение');

    const stored = locationConsentText([LOCATION_PURPOSES.DTP_EVIDENCE]);
    assert(/СОХРАНЯЮТСЯ/.test(stored), 'о сохранении координат снова не сказано');
    assert(!/Координаты не сохраняются/.test(stored), 'сохраняющему применению приписано разовое использование');
    // И сказано, что с этим можно сделать: честность без выхода — это
    // просто плохая новость.
    assert(/Удалить/.test(stored), 'не сказано, как удалить сохранённые координаты');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: смешанный набор не выдаёт себя за разовый', () => {
    // Самый опасный случай: одно сохраняющее применение среди трёх
    // разовых. Прежняя фраза покрывала бы его целиком.
    const mixed = locationConsentText([LOCATION_PURPOSES.WEATHER, LOCATION_PURPOSES.MAJOR_PURCHASE]);
    assert(/СОХРАНЯЮТСЯ/.test(mixed), 'смешанный набор подан как разовый');
    assert(/вариант покупки/.test(mixed), 'не названо, какое именно применение сохраняет координаты');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: на экране не осталось фразы «никогда не сохраняются»', () => {
    // Правило по дереву: фраза не должна вернуться ни на одном экране,
    // как бы он ни назывался.
    const offenders = screens().filter((f) => /Координаты никогда не сохраняются/.test(code(f)));
    assert(offenders.length === 0, `обещание вернулось: ${offenders.map((f) => f.slice(SRC.length + 1)).join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: обе двери к согласию говорят ОДНИМИ словами', () => {
    // Второй экземпляр текста — способ разойтись с первым; ровно так
    // разошлись `purposes` и проверка.
    const confirmDoor = code(join(SRC, 'components/domains/DomainExtrasManual.tsx'));
    assert(/locationConsentText\(/.test(confirmDoor), 'вторая дверь снова пишет свой текст');
    assert(!/нужно согласие на обработку геолокации/.test(confirmDoor), 'прежний неполный текст второй двери на месте');
    const prompt = code(join(SRC, 'components/LocationConsentPrompt.tsx'));
    assert(/locationConsentText\(asked\)/.test(prompt), 'экранное согласие снова печатает текст мимо словаря');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: у геометки на доказательстве появилась своя дверь', () => {
    const dtp = code(join(SRC, 'components/domains/dtp/DtpWorkspace.tsx'));
    assert(/LOCATION_PURPOSES\.DTP_EVIDENCE/.test(dtp), 'геометка ДТП снова опирается на чужое согласие');
    // Не «имя встречается в файле»: спрашивают ДО отправки и показывают
    // экран согласия — уроки [decision-basis] и следующих трёх пунктов.
    assert(/checkLocationConsent\(LOCATION_PURPOSES\.DTP_EVIDENCE\)/.test(dtp), 'согласие не проверяется перед отправкой');
    assert(/<LocationConsentPrompt/.test(dtp), 'экран согласия не показывается');
    // И только когда координаты действительно есть: спрашивать согласие
    // на геометку у того, кто её не ставил, — тоже неправда.
    assert(/hasGeo &&/.test(dtp), 'согласие спрашивается и без координат');
    assert(/она сохраняется вместе с файлом/.test(dtp), 'на экране не сказано, что геометка остаётся в материале');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: клиентская проверка не мягче серверной', () => {
    // Если экран проверяет слабее, человек получит отказ вместо
    // вопроса — и не поймёт, что делать.
    const prompt = code(join(SRC, 'components/LocationConsentPrompt.tsx'));
    assert(/c\.purposes\.includes\(purpose\)/.test(prompt), 'клиентская проверка снова не смотрит в применения');
  }],

  ['ИЗМЕРЕНИЕ: каждый потребитель экрана согласия называет своё применение', () => {
    // Точка отсчёта: пятый экран, зовущий согласие без применения,
    // получит умолчание из трёх разовых — и это должно быть видно.
    const users = screens().filter((f) => /<LocationConsentPrompt/.test(code(f)));
    assert(users.length === 4, `экранов с согласием на геолокацию должно быть 4, найдено ${users.length}: ` +
      users.map((f) => f.slice(SRC.length + 1)).join(', '));
    for (const f of users) {
      assert(/purposes=\{\[LOCATION_PURPOSES\./.test(code(f)), `${f.slice(SRC.length + 1)}: применение не названо`);
    }
  }],

  ['ИЗМЕРЕНИЕ: словарь применений полон и неизвестных нет', () => {
    assert(LOCATION_PURPOSE_SPECS.length === 5, `применений должно быть 5, найдено ${LOCATION_PURPOSE_SPECS.length}`);
    assert(LOCATION_PURPOSE_SPECS.filter((s) => s.storesCoordinates).length === 2, 'изменилось число применений, сохраняющих координаты');
    assert(locationPurposeSpec('несуществующее') === null, 'неизвестное применение опознано как известное');
    assert(locationConsentText([]) === 'Разрешить использование геолокации.', 'пустой набор рождает утверждение о хранении');
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nconsent-purpose: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
