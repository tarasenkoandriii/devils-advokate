// Пункт [health-lab-ocr] — клієнт Google Cloud Vision API
// (TEXT_DETECTION), raw fetch без SDK, той самий принцип, що
// google-places-client.ts/nominatim-client.ts/serpapi-client.ts.
//
// НАЙВАЖЛИВІШЕ АРХІТЕКТУРНЕ РІШЕННЯ: base64-вміст передається НАПРЯМУ
// в тілі POST-запиту (`image.content`), НЕ через публічний Vercel
// Blob, як у PhotoVerificationService (реверс-пошук). Жодного вікна
// публічної доступності зображення взагалі — суворіше за прецедент,
// не тому, що прецедент недостатній, а тому, що медичний документ
// чутливіший за фото для верифікації особи.
//
// ЧЕСНО: контракт відновлено за офіційною документацією Google Cloud
// Vision API, не перевірено викликом проти реального сервісу в цьому
// середовищі розробки — той самий клас оговорки, що вже застосований
// до Nominatim/sherpa-onnx та інших зовнішніх інтеграцій проєкту.

const VISION_API_HOST = 'https://vision.googleapis.com/v1/images:annotate';

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrError';
  }
}

/** base64Content — БЕЗ префіксу "data:image/...;base64,", сирі base64
 * дані. apiKey — Google Cloud API key з увімкненим Vision API. */
export async function extractTextFromImage(base64Content: string, apiKey: string): Promise<string> {
  const url = `${VISION_API_HOST}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: [
      {
        image: { content: base64Content },
        features: [{ type: 'TEXT_DETECTION' }],
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OcrError(`Vision API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new OcrError(`Vision API returned ${response.status}`);
  }

  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  const annotation = data?.responses?.[0]?.fullTextAnnotation?.text;
  if (data?.responses?.[0]?.error) {
    throw new OcrError(`Vision API error: ${data.responses[0].error.message ?? 'unknown'}`);
  }
  if (typeof annotation !== 'string' || annotation.trim().length === 0) {
    throw new OcrError('Vision API не розпізнав жодного тексту на зображенні');
  }
  return annotation;
}
