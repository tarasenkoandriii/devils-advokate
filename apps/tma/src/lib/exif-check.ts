// Пункт 58 (§3.19 ТЗ) — проверка EXIF-метаданных на GPS-координаты,
// ЦЕЛИКОМ на клиенте (браузере), без отправки исходного файла на
// сервер даже для этой проверки — тот же принцип locality, что и у
// самого fileRef/url (см. schema.prisma, модель FactSource).
//
// РУЧНОЙ ПАРСЕР JPEG/EXIF, БЕЗ ВНЕШНИХ БИБЛИОТЕК — тот же принцип
// минимальных зависимостей, что весь остальной проект (сырой fetch()
// для внешних API вместо SDK). JPEG: сегменты начинаются с 0xFF +
// маркер; APP1 (0xFFE1) содержит "Exif\0\0" + TIFF-заголовок; ищем
// тег GPS IFD Pointer (0x8825) в IFD0 — присутствие само по себе
// означает наличие GPS-данных, координаты не парсятся (для
// предупреждения "есть/нет" не требуется декодировать сами значения).
//
// ЧЕСТНАЯ ГРАНИЦА ОБЪЁМА — Пункт 89 добавил MP4/QuickTime (.mp4/.mov)
// как самый распространённый видео-контейнер с телефонов. Другие
// контейнеры (WebM/AVI/etc) — принципиально иначе устроены (не
// box-based ISO base media format), НЕ реализованы, честно ограничено
// MP4/MOV. ВНУТРИ MP4/MOV — проверяется только одна, но самая
// распространённая конвенция хранения геометки: атом "©xyz" (ISO 6709
// строка) внутри moov/udta, стандарт Apple/QuickTime, широко принятый
// другими производителями. Иные конвенции (например XMP-пакет в uuid-
// атоме, iTunes-style meta/keys/ilst с ключом location.ISO6709) — НЕ
// проверяются, отсутствие геометки не гарантированно означает
// действительное отсутствие, если файл использует нестандартную
// конвенцию — та же честность, что "не все локали" у WhatsApp-
// парсера (Пункт 61).

export interface ExifCheckResult {
  hasGeoTag: boolean;
  checkedFormat: 'jpeg' | 'mp4' | 'unsupported';
}

const JPEG_SOI = 0xffd8; // Start Of Image
const APP1_MARKER = 0xffe1;
const GPS_IFD_POINTER_TAG = 0x8825;

/** Проверяет File на наличие GPS EXIF-тега. Поддерживает только JPEG
 * — для остальных форматов (включая видео) возвращает
 * checkedFormat: 'unsupported', hasGeoTag: false — честно "не
 * проверено", не ложное "чисто". */
export async function checkExifForGeoTag(file: File): Promise<ExifCheckResult> {
  const isJpeg = file.type === 'image/jpeg' || !!file.name.toLowerCase().match(/\.(jpe?g)$/);
  const isMp4 = file.type === 'video/mp4' || file.type === 'video/quicktime' || !!file.name.toLowerCase().match(/\.(mp4|mov)$/);

  if (isMp4 && !isJpeg) {
    const hasGeoTag = await checkMp4ForGeoTag(file);
    return { hasGeoTag, checkedFormat: 'mp4' };
  }
  if (!isJpeg) {
    return { hasGeoTag: false, checkedFormat: 'unsupported' };
  }

  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

  if (view.byteLength < 4 || view.getUint16(0, false) !== JPEG_SOI) {
    return { hasGeoTag: false, checkedFormat: 'unsupported' };
  }

  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break; // не сегмент — повреждён или конец
    const segmentLength = view.getUint16(offset + 2, false);

    if (marker === APP1_MARKER) {
      const exifStart = offset + 4;
      // "Exif\0\0" — 6 байт сигнатуры перед TIFF-заголовком
      const isExif =
        view.getUint8(exifStart) === 0x45 && // E
        view.getUint8(exifStart + 1) === 0x78 && // x
        view.getUint8(exifStart + 2) === 0x69 && // i
        view.getUint8(exifStart + 3) === 0x66; // f
      if (isExif) {
        const hasGps = scanTiffForGpsTag(view, exifStart + 6);
        if (hasGps) return { hasGeoTag: true, checkedFormat: 'jpeg' };
      }
    }

    if (marker === 0xffda) break; // Start Of Scan — метаданные закончились, дальше пиксели
    offset += 2 + segmentLength;
  }

  return { hasGeoTag: false, checkedFormat: 'jpeg' };
}

function scanTiffForGpsTag(view: DataView, tiffStart: number): boolean {
  const byteOrderMark = view.getUint16(tiffStart, false);
  const littleEndian = byteOrderMark === 0x4949; // "II"
  if (byteOrderMark !== 0x4949 && byteOrderMark !== 0x4d4d) return false; // не "II" и не "MM" — не TIFF

  const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
  const entryCount = view.getUint16(tiffStart + ifd0Offset, littleEndian);

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = tiffStart + ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, littleEndian);
    if (tag === GPS_IFD_POINTER_TAG) return true;
  }
  return false;
}

/** "Опция в один клик — очистить метаданные" (§3.19 ТЗ) — вырезает
 * найденный APP1-сегмент (EXIF), возвращает новый File без него.
 * Остальные сегменты (включая сами данные изображения) не трогаются. */
export async function stripExifMetadata(file: File): Promise<File> {
  const isMp4 = file.type === 'video/mp4' || file.type === 'video/quicktime' || !!file.name.toLowerCase().match(/\.(mp4|mov)$/);
  if (isMp4) {
    return stripMp4Metadata(file);
  }

  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

  if (view.byteLength < 4 || view.getUint16(0, false) !== JPEG_SOI) {
    return file; // не JPEG и не MP4/MOV — нечего вырезать, возвращаем как есть
  }

  const segments: { start: number; end: number; keep: boolean }[] = [{ start: 0, end: 2, keep: true }];
  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break;
    const segmentLength = view.getUint16(offset + 2, false);
    const segmentEnd = offset + 2 + segmentLength;
    segments.push({ start: offset, end: segmentEnd, keep: marker !== APP1_MARKER });
    if (marker === 0xffda) {
      segments.push({ start: segmentEnd, end: view.byteLength, keep: true }); // сжатые данные изображения до конца файла
      break;
    }
    offset = segmentEnd;
  }

  const keptParts = segments.filter((s) => s.keep).map((s) => buffer.slice(s.start, s.end));
  return new File(keptParts, file.name, { type: file.type });
}

// ───────────────────────────────────────────────────────────
// Пункт 89 (§3.19 ТЗ) — MP4/QuickTime box-based парсер. Каждый "box"
// (он же "atom"): 4 байта big-endian размер + 4 байта тип (fourCC) +
// тело. size=1 означает "смотри следующие 8 байт как 64-битный
// largesize" (для файлов больше 4ГБ); size=0 означает "box до конца
// файла" — оба случая честно обработаны, не просто отброшены как
// нераспознанные.
//
// "©xyz" (0xA9 + 'xyz') — box геометки Apple/QuickTime, ISO 6709
// строка вида "+37.3349-122.0090+000.000/". Присутствие тега
// проверяется, сама строка координат НЕ парсится и не декодируется —
// тот же принцип, что у JPEG GPS IFD Pointer выше: для
// предупреждения "есть/нет" не нужны сами координаты.
// ───────────────────────────────────────────────────────────

const QUICKTIME_LOCATION_BOX_TYPE = '\u00a9xyz';
// Известные box-типы, чьё тело — это НЕПОСРЕДСТВЕННО последовательность
// дочерних box'ов (контейнеры), не сырые данные — только в них имеет
// смысл рекурсивно искать geo-тег дальше.
const CONTAINER_BOX_TYPES = new Set(['moov', 'trak', 'udta', 'mdia', 'minf', 'stbl']);
const MAX_BOX_DEPTH = 12; // защита от аномально глубокой вложенности повреждённого/специально сконструированного файла

function readBoxTypeString(view: DataView, offset: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Возвращает {boxSize, headerSize} для box'а по смещению offset, или
 * null, если box повреждён/не помещается в границы [offset, end). */
function readBoxHeader(view: DataView, offset: number, end: number): { boxSize: number; headerSize: number } | null {
  if (offset + 8 > end) return null;
  const size32 = view.getUint32(offset, false);
  let boxSize = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (offset + 16 > end) return null;
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    boxSize = high * 2 ** 32 + low; // JS-числа теряют точность за пределами 2^53 — честная граница для файлов астрономического размера
    headerSize = 16;
  } else if (size32 === 0) {
    boxSize = end - offset;
  }
  if (boxSize < headerSize || offset + boxSize > end) return null;
  return { boxSize, headerSize };
}

function findGeoTagInBoxes(view: DataView, start: number, end: number, depth: number): boolean {
  if (depth > MAX_BOX_DEPTH) return false;
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (!header) break; // повреждённый хвост — честно прекращаем разбор этого уровня, не гадаем
    const { boxSize, headerSize } = header;
    const type = readBoxTypeString(view, offset + 4);

    if (type === QUICKTIME_LOCATION_BOX_TYPE) return true;
    if (CONTAINER_BOX_TYPES.has(type)) {
      if (findGeoTagInBoxes(view, offset + headerSize, offset + boxSize, depth + 1)) return true;
    }
    offset += boxSize;
  }
  return false;
}

export async function checkMp4ForGeoTag(file: File): Promise<boolean> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  return findGeoTagInBoxes(view, 0, view.byteLength, 0);
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/** Рекурсивно перестраивает дерево box'ов, вырезая "©xyz" на любом
 * уровне вложенности. Контейнерные box'и (moov/udta/...) должны
 * получить ОБНОВЛЁННЫЙ размер после удаления дочернего box'а — иначе
 * файл станет повреждённым для любого другого парсера (размер box'а
 * должен точно соответствовать его реальному содержимому). Новый
 * заголовок размера всегда пишется как 32-битный — честная граница:
 * если после удаления box размер каким-то образом всё ещё требовал
 * бы 64-битного largesize (по факту невозможно после УМЕНЬШЕНИЯ
 * размера, только теоретически для файлов >4ГБ до удаления), не
 * обрабатывается отдельно. */
function rebuildBoxes(view: DataView, start: number, end: number, depth: number): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (!header) {
      // Повреждённый/незавершённый хвост — честно сохраняем как есть, не пытаемся переинтерпретировать.
      parts.push(new Uint8Array(view.buffer.slice(offset, end)));
      break;
    }
    const { boxSize, headerSize } = header;
    const type = readBoxTypeString(view, offset + 4);

    if (type === QUICKTIME_LOCATION_BOX_TYPE) {
      offset += boxSize;
      continue; // сам вырез — box геометки не попадает в результат
    }

    if (CONTAINER_BOX_TYPES.has(type) && depth < MAX_BOX_DEPTH) {
      const rebuiltChildren = rebuildBoxes(view, offset + headerSize, offset + boxSize, depth + 1);
      const newBoxSize = headerSize + rebuiltChildren.length;
      const newBox = new Uint8Array(newBoxSize);
      const newBoxView = new DataView(newBox.buffer);
      newBoxView.setUint32(0, newBoxSize, false);
      for (let i = 0; i < 4; i++) newBox[4 + i] = view.getUint8(offset + 4 + i);
      newBox.set(rebuiltChildren, headerSize);
      parts.push(newBox);
    } else {
      parts.push(new Uint8Array(view.buffer.slice(offset, offset + boxSize)));
    }
    offset += boxSize;
  }
  return concatUint8Arrays(parts);
}

export async function stripMp4Metadata(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const rebuilt = rebuildBoxes(view, 0, view.byteLength, 0);
  return new File([rebuilt], file.name, { type: file.type });
}
