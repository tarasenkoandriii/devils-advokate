// Пункт 60 (backend) → TMA: клиентское извлечение текста из .md/PPTX
// (§3.27 ТЗ) — "первоисточники на сервер не передаются", извлечение
// ЦЕЛИКОМ в браузере, на сервер уходит только результат этой функции
// (строка текста), не файл и не его бинарное содержимое.
//
// PPTX-ПАРСЕР: РУЧНОЙ РАЗБОР БИНАРНОЙ СТРУКТУРЫ ZIP (тот же принцип,
// что EXIF-парсер, Пункт 58), НЕ полноценная ZIP-библиотека — PPTX
// это ZIP-архив, слайды лежат как ppt/slides/slideN.xml со сжатием
// deflate. Полноценный ZIP-парсер (произвольные флаги, data
// descriptors, ZIP64) не поднимается вручную за один проход — вместо
// этого используется нативный браузерный DecompressionStream
// ('deflate-raw'), который умеет распаковывать raw deflate без единой
// внешней библиотеки (Chrome/Edge/Safari современных версий — тот же
// уровень поддержки, что и у Telegram WebView).
//
// ЧЕСТНАЯ ГРАНИЦА ПАРСЕРА, НЕ СКРЫТАЯ: не обрабатывает ZIP-записи с
// установленным флагом "data descriptor" (бит 3) — размеры сжатых
// данных в этом случае хранятся ПОСЛЕ данных, не в самом заголовке,
// что требует другого алгоритма прохода по файлу. PowerPoint
// стандартно не выставляет этот флаг для обычных .pptx — известное,
// не универсальное ограничение, как и у EXIF-парсера.

export interface MaterialExtractResult {
  text: string;
  format: 'markdown' | 'pptx' | 'unsupported';
}

export async function extractMaterialText(file: File): Promise<MaterialExtractResult> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.md') || file.type === 'text/markdown') {
    const text = await file.text();
    return { text, format: 'markdown' };
  }

  if (name.endsWith('.pptx') || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    const text = await extractPptxText(file);
    return { text, format: 'pptx' };
  }

  return { text: '', format: 'unsupported' };
}

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const SLIDE_PATH_PATTERN = /^ppt\/slides\/slide\d+\.xml$/;

async function extractPptxText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const slideTexts: { index: number; text: string }[] = [];
  let offset = 0;

  while (offset + 30 <= view.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature !== ZIP_LOCAL_FILE_SIGNATURE) break; // конец локальных записей (начались central directory и т.д.)

    const flags = view.getUint16(offset + 6, true);
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);

    const nameStart = offset + 30;
    const fileName = new TextDecoder('utf-8').decode(bytes.slice(nameStart, nameStart + fileNameLength));
    const dataStart = nameStart + fileNameLength + extraFieldLength;

    // Честная граница — см. обоснование в шапке файла.
    const hasDataDescriptor = (flags & 0x08) !== 0;

    if (SLIDE_PATH_PATTERN.test(fileName) && !hasDataDescriptor && compressedSize > 0) {
      const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
      let xmlBytes: Uint8Array;
      if (compressionMethod === 0) {
        xmlBytes = compressedData; // stored — без сжатия
      } else if (compressionMethod === 8) {
        xmlBytes = await inflateRaw(compressedData);
      } else {
        offset = dataStart + compressedSize;
        continue; // неподдерживаемый метод сжатия — пропускаем этот файл, не падаем
      }
      const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
      const slideIndex = parseInt(fileName.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
      slideTexts.push({ index: slideIndex, text: extractTextFromSlideXml(xmlText) });
    }

    offset = dataStart + compressedSize;
    if (uncompressedSize === 0 && compressedSize === 0 && !hasDataDescriptor) break; // защита от зацикливания на повреждённом файле
  }

  return slideTexts
    .sort((a, b) => a.index - b.index)
    .map((s, i) => `Слайд ${i + 1}:\n${s.text}`)
    .join('\n\n');
}

/** Не полноценный XML-парсер — извлекает содержимое всех тегов
 * <a:t>...</a:t> (текстовые runs в OOXML), этого достаточно для целей
 * извлечения текста слайда, полноценное дерево DOM не требуется. */
function extractTextFromSlideXml(xml: string): string {
  const matches = xml.matchAll(/<a:t>([^<]*)<\/a:t>/g);
  return [...matches].map((m) => m[1]).join(' ');
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Явное копирование в Uint8Array с гарантированным ArrayBuffer (не
  // ArrayBufferLike/SharedArrayBuffer) — Blob-конструктор в новых
  // версиях типов TS требует именно этого.
  const plainBuffer = new Uint8Array(data).buffer as ArrayBuffer;
  const stream = new Blob([plainBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}
