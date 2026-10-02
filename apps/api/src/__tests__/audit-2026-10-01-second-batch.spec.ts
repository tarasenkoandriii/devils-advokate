// Полная сверка 2026-10-01, второй круг — находки среднего веса, у
// которых цена ошибки высокая: продукт говорит человеку неправду, или
// чужой идентификатор меняет наш запрос, или платный источник отказывает
// молча.
//
// Закрыто здесь:
//   [the-type-we-invented-ourselves] — продукт отдавал провайдеру
//       MIME-тип, который сам же и придумал, а человеку говорил «с
//       вашими материалами всё в порядке».
//   [the-identifier-reshaped-the-url] — `place_id` и `voiceId` из тела
//       запроса подставлялись в адрес провайдера без кодирования и без
//       проверки алфавита; у `voiceId` — в ПУТЬ.
//   [the-branch-that-could-not-be-reached] — ветка про 204 у Windy была
//       недостижима, а фоллбек на запасной источник не логировался
//       вообще.

import { geminiMediaTypeProblem, GEMINI_MEDIA_TYPES } from '../ai-router/provider-media-types';
import {
  PLACE_ID_ALLOWED,
  VOICE_ID_ALLOWED,
  ProviderIdFormatError,
  safeProviderId,
} from '../common/provider-id-format';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('[the-type-we-invented-ourselves] тип файла проверяется до провайдера', () => {
  it('наше придуманное умолчание отвергается — именно оно и ломало разбор', () => {
    expect(geminiMediaTypeProblem('application/octet-stream')).not.toBeNull();
  });

  it('отказ говорит, что дело В ТИПЕ ФАЙЛА, и что делать — а не «всё в порядке»', () => {
    const problem = geminiMediaTypeProblem('application/octet-stream') ?? '';
    expect(/тип[еа]? файла/i.test(problem)).toBe(true);
    expect(problem.includes('mp3')).toBe(true);
    // Ровно та фраза, которую человек читал раньше и которая была ложью.
    expect(problem.includes('с вашими материалами всё в порядке')).toBe(false);
  });

  it('настоящие типы проходят, параметры вида codecs не мешают', () => {
    expect(geminiMediaTypeProblem('audio/mpeg')).toBeNull();
    expect(geminiMediaTypeProblem('audio/webm; codecs=opus')).toBeNull();
    expect(geminiMediaTypeProblem('video/mp4')).toBeNull();
    expect(geminiMediaTypeProblem('AUDIO/MP4')).toBeNull();
  });

  it('пустой тип отвергается отдельной причиной: «не указан» и «не тот» — разные новости', () => {
    const empty = geminiMediaTypeProblem('') ?? '';
    const wrong = geminiMediaTypeProblem('text/plain') ?? '';
    expect(empty.includes('не указан тип')).toBe(true);
    expect(String(empty) === String(wrong)).toBe(false);
  });

  it('проверка стои́т ДО постановки задачи, а не после отказа провайдера', () => {
    const src = stripComments(read('conversations/paralinguistics.service.ts'));
    const check = src.indexOf('geminiMediaTypeProblem(');
    const enqueue = src.indexOf('this.aiRouter.enqueue(');
    expect(check > 0).toBe(true);
    expect(enqueue > 0).toBe(true);
    expect(check < enqueue).toBe(true);
  });

  it('придуманного умолчания в медиа-блоке больше нет', () => {
    const src = stripComments(read('conversations/paralinguistics.service.ts'));
    expect(src.includes("?? 'application/octet-stream'")).toBe(false);
  });

  // Проба переписана после того, как сторож [probe-checked-the-neighbour]
  // её отверг: она не трогала ни одного имени, объявленного в спеке, —
  // то есть проверяла не ту машинерию, что ключевые тесты рядом. Заодно
  // стала отвечать на вопрос, который без неё оставался открытым:
  // проверяется ли ТОТ список, на который опирается продукт.
  it('обратная проба: список типов не пуст, разбор смотрит в него, и продукт зовёт именно этот разбор', () => {
    expect(GEMINI_MEDIA_TYPES.length > 5).toBe(true);
    for (const t of GEMINI_MEDIA_TYPES) expect(geminiMediaTypeProblem(t)).toBeNull();
    const src = stripComments(read('conversations/paralinguistics.service.ts'));
    expect(src.includes("from '../ai-router/provider-media-types'")).toBe(true);
  });
});

describe('[the-identifier-reshaped-the-url] чужой идентификатор не меняет наш адрес', () => {
  it('настоящие идентификаторы проходят', () => {
    expect(safeProviderId('ChIJN1t_tDeuEmsRUsoyG83frY4', PLACE_ID_ALLOWED, 'место')).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(safeProviderId('21m00Tcm4TlvDq8ikWAM', VOICE_ID_ALLOWED, 'голос')).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('РЕГРЕССИЯ (прогон 19): дефис и подчёркивание в идентификаторе голоса ПРОХОДЯТ — алфавит провайдера, а не мой', () => {
    // Первая редакция `VOICE_ID_ALLOWED` разрешала только буквы и цифры
    // и тем самым отказывалась вызывать провайдера для голоса вида
    // `voice-A`. Поймал это не этот файл, а существующий тест кэша
    // голосов, упавший «ElevenLabs недоступен». Проверка стои́т здесь,
    // рядом с правилом, чтобы следующее сужение алфавита падало в
    // пункте, который его завёл.
    expect(safeProviderId('voice-A', VOICE_ID_ALLOWED, 'голос')).toBe('voice-A');
    expect(safeProviderId('my_voice_2', VOICE_ID_ALLOWED, 'голос')).toBe('my_voice_2');
  });

  it('значение, переписывающее строку запроса, отвергается', () => {
    expect(() => safeProviderId('ChIJabc&key=stolen', PLACE_ID_ALLOWED, 'место')).toThrow(ProviderIdFormatError);
  });

  it('значение, уводящее на ДРУГОЙ эндпоинт провайдера, отвергается', () => {
    expect(() => safeProviderId('../../v1/history', VOICE_ID_ALLOWED, 'голос')).toThrow(ProviderIdFormatError);
    expect(() => safeProviderId('X?optimize_streaming_latency=4', VOICE_ID_ALLOWED, 'голос')).toThrow(ProviderIdFormatError);
  });

  it('отказ объясняет, ЧТО не так, а не просто «неверно»', () => {
    try {
      safeProviderId('a/b', VOICE_ID_ALLOWED, 'Идентификатор голоса');
      throw new Error('не отвергнуто');
    } catch (e) {
      const message = (e as Error).message;
      expect(message.includes('Идентификатор голоса')).toBe(true);
      expect(message.includes('адрес запроса')).toBe(true);
    }
  });

  it('оба места провайдера зовут проверку, и ни одно не подставляет значение напрямую', () => {
    const places = stripComments(read('venue-recommendation/google-places-client.ts'));
    expect(places.includes('safeProviderId(placeId')).toBe(true);
    expect(places.includes('place_id=${placeId}')).toBe(false);
    const tts = stripComments(read('text-to-speech/text-to-speech.service.ts'));
    expect(tts.includes('safeProviderId(voiceId')).toBe(true);
    expect(tts.includes('text-to-speech/${voiceId}')).toBe(false);
  });

  it('обратная проба: кодирование остаётся второй линией — допустимое значение проходит неизменным, недопустимое не «чинится»', () => {
    expect(safeProviderId('abc.def-_', PLACE_ID_ALLOWED, 'место')).toBe('abc.def-_');
    expect(() => safeProviderId('abc def', PLACE_ID_ALLOWED, 'место')).toThrow(ProviderIdFormatError);
  });
});

describe('[the-branch-that-could-not-be-reached] 204 и молчаливый фоллбек', () => {
  const windy = stripComments(read('weather-forecast/windy-client.ts'));
  const service = stripComments(read('weather-forecast/weather-forecast.service.ts'));

  it('204 проверяется ОТДЕЛЬНО и ПЕРЕД response.ok — иначе ветка недостижима', () => {
    const status204 = windy.indexOf('response.status === 204');
    const okCheck = windy.indexOf('if (!response.ok)');
    expect(status204 > 0).toBe(true);
    expect(okCheck > 0).toBe(true);
    expect(status204 < okCheck).toBe(true);
  });

  it('204 больше не доезжает до разбора JSON на пустом теле', () => {
    const status204 = windy.indexOf('response.status === 204');
    const json = windy.indexOf('await response.json()');
    expect(status204 < json).toBe(true);
  });

  it('отказ платного источника пишется в лог — раньше был голый catch без логгера', () => {
    // Запись должна быть ВНУТРИ того самого catch, а не где-то в файле:
    // мутация `void 0 === 0 && this.logger.warn(` проверку «строка есть»
    // ВЫЖИЛА.
    expect(/getWindyForecast\(windyKey, coords, targetDate\);\s*\} catch \(err\) \{[\s\S]{0,1400}?this\.logger\.warn\(/.test(service)).toBe(true);
    expect(/catch \{\s*\}/.test(service)).toBe(false);
    expect(service.includes('private readonly logger')).toBe(true);
  });

  it('обратная проба: разбор ветвится по статусу, а не отвергает любой ответ', () => {
    expect(windy.includes('if (!response.ok)')).toBe(true);
    expect(windy.includes('const data = (await response.json()) as WindyResponse')).toBe(true);
  });
});
