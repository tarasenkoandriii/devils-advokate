import { extractMaterialText } from '../lib/material-extract';
import { deflateRawSync } from 'zlib';

// Строит минимальный синтетический ZIP-буфер (структура PPTX) с ОДНОЙ
// локальной записью — ppt/slides/slide1.xml, реально сжатой через
// zlib.deflateRawSync (тот же алгоритм raw deflate, что браузерный
// DecompressionStream('deflate-raw') должен уметь распаковывать).
function buildSyntheticPptxZip(slideXml: string): Uint8Array<ArrayBuffer> {
  const fileName = 'ppt/slides/slide1.xml';
  const fileNameBytes = new TextEncoder().encode(fileName);
  const xmlBytes = new TextEncoder().encode(slideXml);
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(xmlBytes)));

  const header = new Uint8Array(30 + fileNameBytes.length);
  const view = new DataView(header.buffer);

  view.setUint32(0, 0x04034b50, true); // local file header signature
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, 0, true); // flags — БЕЗ data descriptor (бит 3 = 0)
  view.setUint16(8, 8, true); // compression method = deflate
  view.setUint16(10, 0, true); // mod time
  view.setUint16(12, 0, true); // mod date
  view.setUint32(14, 0, true); // crc32 — не проверяется парсером, можно 0
  view.setUint32(18, compressed.length, true); // compressed size
  view.setUint32(22, xmlBytes.length, true); // uncompressed size
  view.setUint16(26, fileNameBytes.length, true); // filename length
  view.setUint16(28, 0, true); // extra field length
  header.set(fileNameBytes, 30);

  const result = new Uint8Array(header.length + compressed.length);
  result.set(header, 0);
  result.set(compressed, header.length);
  return result;
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

  test('extractMaterialText() извлекает текст из .md-файла как есть', async () => {
    const file = new File(['# Заголовок\n\nТекст документа'], 'doc.md', { type: 'text/markdown' });
    const result = await extractMaterialText(file);
    assertEqual(result.format, 'markdown', 'формат распознан');
    assertEqual(result.text, '# Заголовок\n\nТекст документа', 'текст .md извлечён как есть');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: extractMaterialText() распаковывает реально deflate-сжатый слайд из синтетического PPTX и извлекает текст', async () => {
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:t>Заголовок слайда</a:t><a:t>Первый пункт</a:t></p:sld>';
    const zipBytes = buildSyntheticPptxZip(slideXml);
    const file = new File([zipBytes], 'presentation.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

    const result = await extractMaterialText(file);
    assertEqual(result.format, 'pptx', 'формат распознан как pptx');
    assertEqual(result.text.includes('Заголовок слайда'), true, 'первый текстовый run реально распакован и извлечён');
    assertEqual(result.text.includes('Первый пункт'), true, 'второй текстовый run реально распакован и извлечён');
  });

  test('extractMaterialText() возвращает unsupported для неподдерживаемого формата', async () => {
    const file = new File([new Uint8Array([0, 1, 2])], 'document.pdf', { type: 'application/pdf' });
    const result = await extractMaterialText(file);
    assertEqual(result.format, 'unsupported', 'формат честно помечен как неподдерживаемый');
    assertEqual(result.text, '', 'пустой текст, не выдумка');
  });

  test('extractMaterialText() не падает на пустом .pptx-подобном буфере (нет валидных ZIP-записей)', async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], 'broken.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const result = await extractMaterialText(file);
    assertEqual(result.text, '', 'пустой результат для повреждённого архива, не падение');
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
  console.log(`\nmaterial-extract: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});
