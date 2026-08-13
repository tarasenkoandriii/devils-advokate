import { checkExifForGeoTag, stripExifMetadata, checkMp4ForGeoTag, stripMp4Metadata } from '../lib/exif-check';

// Строит минимальный синтетический JPEG-подобный буфер: SOI + APP1
// (Exif + TIFF IFD0 с одной записью) + SOS + "данные изображения".
// Не настоящий декодируемый JPEG — но структурно достаточен, чтобы
// проверить именно логику сегмент-парсера/поиска тега, не рендеринг.
function buildSyntheticJpeg(options: { includeGpsTag: boolean }): Uint8Array {
  const parts: number[] = [];

  // SOI
  parts.push(0xff, 0xd8);

  // --- APP1 (Exif) ---
  // ВАЖНО: TIFF-заголовок ниже объявлен как "II" (little-endian) —
  // все многобайтовые поля внутри IFD-записей (tag/type/count/value)
  // ДОЛЖНЫ быть в little-endian, в отличие от JPEG-маркеров сегментов
  // снаружи (те всегда big-endian по спецификации JPEG).
  const tiffEntries: number[] = [];
  // Запись 1: Orientation (0x0112), type=SHORT(3), count=1, value=1
  tiffEntries.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00);
  if (options.includeGpsTag) {
    // Запись 2: GPS IFD Pointer (0x8825), type=LONG(4), count=1, value=offset(26)
    tiffEntries.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00);
  }
  const entryCount = options.includeGpsTag ? 2 : 1;

  const ifd0: number[] = [];
  ifd0.push(entryCount & 0xff, (entryCount >> 8) & 0xff); // entry count, little-endian
  ifd0.push(...tiffEntries);
  ifd0.push(0x00, 0x00, 0x00, 0x00); // next IFD offset = 0 (нет следующего)

  const tiffHeader: number[] = [
    0x49, 0x49, // "II" — little-endian
    0x2a, 0x00, // magic 42
    0x08, 0x00, 0x00, 0x00, // IFD0 offset = 8
  ];

  const exifSignature = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const app1Payload = [...exifSignature, ...tiffHeader, ...ifd0];
  const app1Length = app1Payload.length + 2; // включая сами 2 байта длины

  parts.push(0xff, 0xe1); // APP1 marker
  parts.push((app1Length >> 8) & 0xff, app1Length & 0xff); // length, big-endian (JPEG segment length всегда BE)
  parts.push(...app1Payload);

  // SOS (конец метаданных, начало "данных изображения")
  parts.push(0xff, 0xda, 0x00, 0x02);
  // "данные изображения" — произвольные байты
  parts.push(0x01, 0x02, 0x03, 0x04, 0x05);

  return new Uint8Array(parts);
}

// Строит box (big-endian size + 4-байтный тип + тело).
function buildBox(type: string, body: number[]): number[] {
  const size = 8 + body.length;
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...typeBytes, ...body];
}

// Синтетический MP4/MOV-подобный буфер: ftyp + moov(udta(©xyz?)) —
// минимально достаточен для проверки логики box-парсера, не настоящее
// декодируемое видео.
function buildSyntheticMp4(options: { includeGeoTag: boolean }): Uint8Array {
  const ftyp = buildBox('ftyp', [0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1]); // произвольное содержимое, достаточно валидного box-заголовка

  const xyzString = '+37.3349-122.0090+000.000/';
  const xyzBody = [0, xyzString.length, 0, 0, ...[...xyzString].map((c) => c.charCodeAt(0))]; // [длина, язык, сама строка]
  const xyzBox = options.includeGeoTag ? buildBox('\u00a9xyz', xyzBody) : [];

  const otherUdtaChild = buildBox('\u00a9too', [0x41, 0x42]); // произвольный посторонний box рядом с геометкой — тест не должен путать их
  const udta = buildBox('udta', [...otherUdtaChild, ...xyzBox]);
  const moov = buildBox('moov', udta);

  return new Uint8Array([...ftyp, ...moov]);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('checkExifForGeoTag() обнаруживает GPS-тег в синтетическом JPEG с GPS IFD Pointer', async () => {
    const bytes = buildSyntheticJpeg({ includeGpsTag: true });
    const file = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });

    const result = await checkExifForGeoTag(file);
    assertEqual(result.hasGeoTag, true, 'GPS-тег найден');
    assertEqual(result.checkedFormat, 'jpeg', 'формат распознан как jpeg');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: checkExifForGeoTag() НЕ находит GPS-тег в JPEG без него (не ложное срабатывание)', async () => {
    const bytes = buildSyntheticJpeg({ includeGpsTag: false });
    const file = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });

    const result = await checkExifForGeoTag(file);
    assertEqual(result.hasGeoTag, false, 'GPS-тег корректно не найден, когда его нет');
    assertEqual(result.checkedFormat, 'jpeg', 'формат всё равно распознан и проверен');
  });

  test('checkExifForGeoTag() возвращает unsupported для не-JPEG файла, не притворяется "чисто"', async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02])], 'document.pdf', { type: 'application/pdf' });
    const result = await checkExifForGeoTag(file);
    assertEqual(result.checkedFormat, 'unsupported', 'формат честно помечен как непроверенный');
    assertEqual(result.hasGeoTag, false, 'не заявляет ложного "нет геометки" как факт — просто не проверено');
  });

  test('checkExifForGeoTag() не падает на повреждённом/слишком коротком файле', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8])], 'broken.jpg', { type: 'image/jpeg' });
    const result = await checkExifForGeoTag(file);
    assertEqual(result.hasGeoTag, false, 'короткий файл не роняет проверку');
  });

  test('stripExifMetadata() удаляет APP1-сегмент, GPS-тег больше не находится в результате', async () => {
    const bytes = buildSyntheticJpeg({ includeGpsTag: true });
    const original = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });

    const beforeStrip = await checkExifForGeoTag(original);
    assertEqual(beforeStrip.hasGeoTag, true, 'до очистки — тег присутствует (проверка самого теста)');

    const stripped = await stripExifMetadata(original);
    const afterStrip = await checkExifForGeoTag(stripped);
    assertEqual(afterStrip.hasGeoTag, false, 'после очистки APP1-сегмент вырезан, GPS-тег больше не находится');
  });

  test('stripExifMetadata() сохраняет данные изображения после SOS (не обрезает файл целиком)', async () => {
    const bytes = buildSyntheticJpeg({ includeGpsTag: true });
    const original = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });

    const stripped = await stripExifMetadata(original);
    const strippedBytes = new Uint8Array(await stripped.arrayBuffer());
    // Последние 5 байт — синтетические "данные изображения" из buildSyntheticJpeg
    const tail = Array.from(strippedBytes.slice(-5));
    assertEqual(tail, [0x01, 0x02, 0x03, 0x04, 0x05], 'данные изображения после SOS сохранены, не отрезаны вместе с EXIF');
  });

  // ── Пункт 89: MP4/QuickTime ──

  test('КЛЮЧЕВОЙ ТЕСТ: checkExifForGeoTag() обнаруживает "©xyz" геометку в синтетическом MP4', async () => {
    const bytes = buildSyntheticMp4({ includeGeoTag: true });
    const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
    const result = await checkExifForGeoTag(file);
    assertEqual(result, { hasGeoTag: true, checkedFormat: 'mp4' }, 'geo-тег в moov/udta/©xyz найден рекурсивным box-парсером');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: checkExifForGeoTag() НЕ находит геометку в MP4 без неё — не путает с соседним "©too" box', async () => {
    const bytes = buildSyntheticMp4({ includeGeoTag: false });
    const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
    const result = await checkExifForGeoTag(file);
    assertEqual(result, { hasGeoTag: false, checkedFormat: 'mp4' }, 'без ©xyz — честный false, посторонний ©too рядом не даёт ложного срабатывания');
  });

  test('checkExifForGeoTag() распознаёт .mov по расширению так же, как .mp4', async () => {
    const bytes = buildSyntheticMp4({ includeGeoTag: true });
    const file = new File([bytes], 'video.mov', { type: '' }); // тип файла может быть неизвестен браузеру — расширение как fallback
    const result = await checkExifForGeoTag(file);
    assertEqual(result.checkedFormat, 'mp4', 'формат распознан по расширению .mov');
  });

  test('checkExifForGeoTag() не падает на повреждённом/усечённом MP4', async () => {
    const bytes = new Uint8Array([0, 0, 0, 100, 0x6d, 0x6f, 0x6f, 0x76]); // заявлен box размером 100 байт, но реально только 8 — усечён
    const file = new File([bytes], 'broken.mp4', { type: 'video/mp4' });
    const result = await checkExifForGeoTag(file);
    assertEqual(result.hasGeoTag, false, 'повреждённый файл — честный false, не исключение и не зависание');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: stripMp4Metadata() удаляет геометку, остальная структура остаётся валидной', async () => {
    const bytes = buildSyntheticMp4({ includeGeoTag: true });
    const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });

    const stripped = await stripMp4Metadata(file);
    const hasGeoTagAfter = await checkMp4ForGeoTag(stripped);
    assertEqual(hasGeoTagAfter, false, 'после очистки геометка больше не находится');

    // Соседний box (©too) должен пережить очистку — не вырезано лишнее.
    const strippedBytes = new Uint8Array(await stripped.arrayBuffer());
    const strippedText = String.fromCharCode(...strippedBytes);
    assertEqual(strippedText.includes('\u00a9too'), true, 'посторонний box рядом с геометкой сохранён, не задет очисткой');
  });

  test('stripMp4Metadata() пересчитывает размер родительского box после удаления геометки', async () => {
    const bytes = buildSyntheticMp4({ includeGeoTag: true });
    const withoutGeoTag = buildSyntheticMp4({ includeGeoTag: false });
    const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });

    const stripped = await stripMp4Metadata(file);
    const strippedBytes = new Uint8Array(await stripped.arrayBuffer());
    // После вырезания ©xyz результат должен по длине совпасть с версией, изначально построенной без геометки —
    // если бы размер moov/udta не пересчитался, длина осталась бы прежней (с "дырой" в структуре).
    assertEqual(strippedBytes.length, withoutGeoTag.length, 'итоговая длина совпадает с версией без геометки — размеры box\'ов реально пересчитаны, не оставлена рассинхронизация');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nexif-check: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();
