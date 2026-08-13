// Пункт 87 — клиентское извлечение эмбеддинга голоса через sherpa-onnx
// WASM в браузере, не нативный Node-аддон на backend. Обоснование
// выбора именно WASM-пути — см. /TODO.md, «Идеи за пределами ТЗ»,
// «Голосовой отпечаток».
//
// ДВА РАЗНЫХ УРОВНЯ НЕОПРЕДЕЛЁННОСТИ, ЧЕСТНО РАЗЛИЧЕННЫЕ:
// (1) API Node-аддона (SpeakerEmbeddingExtractor/SpeakerEmbeddingManager)
// подтверждён ТОЧНО — официальная документация k2-fsa полностью
// зафетчена и прочитана перед написанием этого файла.
// (2) Идентичен ли этот же API в WASM-сборке для браузера — НЕ
// подтверждено с той же точностью. Подтверждено только, что
// WASM-модуль ВООБЩЕ поддерживает диаризацию спикеров как фичу
// (JavaScript API with WebAssembly for speaker diarization, #1414 в
// changelog проекта), но не найдена отдельная страница документации,
// подтверждающая точные имена классов/методов WASM-версии
// SpeakerEmbeddingExtractor так же, как для Node-аддона. Код ниже
// написан по аналогии с подтверждённым Node-API (та же экосистема,
// тот же паттерн именования в других биндингах sherpa-onnx — Go/C#
// используют идентичные структуры полей), но ЭТО ПРЕДПОЛОЖЕНИЕ, не
// подтверждённый факт — первое реальное подключение в браузере
// станет первой настоящей проверкой, не прогон в этой среде
// (здесь нет сети для npm install/скачивания WASM-модуля и модели).
//
// НИКОГДА НЕ ОТПРАВЛЯЕТ ЗВУК НА BACKEND — только уже посчитанный
// вектор эмбеддинга (обычный массив чисел). Та же дисциплина, что
// вся остальная акустика проекта.

export interface VoiceEmbeddingExtractorHandle {
  /** Извлекает эмбеддинг из PCM-сэмплов (Float32, любая частота —
   * функция сама ресемплирует внутри модели, как и остальные
   * компоненты sherpa-onnx). Возвращает null, если модуль/модель ещё
   * не загружены — вызывающий код обязан проверить это явно, не
   * получить неожиданное исключение посреди сессии. */
  extractEmbedding: (samples: Float32Array, sampleRate: number) => Float32Array | null;
  dimension: number;
}

let cachedExtractor: VoiceEmbeddingExtractorHandle | null = null;
let loadingPromise: Promise<VoiceEmbeddingExtractorHandle | null> | null = null;

/** Ленивая загрузка WASM-модуля и модели — вызывается один раз за
 * время жизни вкладки, дальше переиспользует уже загруженный
 * экстрактор. modelUrl — путь к .onnx-модели эмбеддинга (см. ссылку
 * на релиз в /TODO.md), должен быть доступен статически в TMA. */
export async function loadVoiceEmbeddingExtractor(modelUrl: string): Promise<VoiceEmbeddingExtractorHandle | null> {
  if (cachedExtractor) return cachedExtractor;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      // Динамический import — WASM-модуль не должен попадать в основной
      // бандл TMA целиком, только когда голосовой отпечаток реально
      // используется (онбординг/экран сопровождения).
      const sherpaOnnx = await import(/* webpackIgnore: true */ 'sherpa-onnx-wasm').catch(() => null);
      if (!sherpaOnnx) return null; // модуль не установлен/не собран — честно null, не бросаем исключение

      // ПРЕДПОЛАГАЕМЫЙ API — см. обоснование в шапке файла.
      const extractor = new (sherpaOnnx as any).SpeakerEmbeddingExtractor({ model: modelUrl });

      const handle: VoiceEmbeddingExtractorHandle = {
        dimension: extractor.dim,
        extractEmbedding: (samples: Float32Array, sampleRate: number) => {
          try {
            const stream = extractor.createStream();
            stream.acceptWaveform({ samples, sampleRate });
            if (!extractor.isReady(stream)) return null; // недостаточно сэмплов для эмбеддинга — честный null
            return extractor.compute(stream) as Float32Array;
          } catch {
            return null;
          }
        },
      };
      cachedExtractor = handle;
      return handle;
    } catch {
      return null; // загрузка WASM/модели не удалась — честный null, вызывающий код показывает ошибку пользователю
    }
  })();

  return loadingPromise;
}

/** Конвертирует Float32Array в обычный number[] для отправки на
 * backend (Prisma Float[] не принимает типизированные массивы
 * напрямую через JSON). Чистая функция, реально тестируемая. */
export function embeddingToArray(embedding: Float32Array): number[] {
  return Array.from(embedding);
}
