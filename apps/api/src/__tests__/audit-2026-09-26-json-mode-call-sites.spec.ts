// Пункт [json-mode-was-asked-and-dropped] 2026-09-26 — МЕРА по дереву.
//
// Отдельным файлом от поведенческой половины намеренно: здесь читается
// текст исходников, и смешивать такие проверки с проверками поведения
// значит прятать вторые за первыми.
//
// ЧЕГО ЭТА МЕРА НЕ ДЕЛАЕТ, И ЭТО ВАЖНО. Она НЕ проверяет, что каждый
// вызов просит формат в промпте, и не может: преобладающая форма —
// `activePrompt?.template ?? SYSTEM_PROMPT`, то есть живой промпт лежит
// в базе и правится оператором. Файл-уровневая проверка «в файле есть
// литерал со словом JSON» зеленела бы и от строки `'(AI call failed or
// returned invalid JSON)'` — это была бы проверка упоминания вместо
// проверки поведения. Поэтому на этот вопрос отвечает РАНТАЙМНАЯ
// проверка в роутере (`checkJsonMode`, предупреждение в момент вызова),
// а здесь — только числа и один конкретный промпт, который пункт
// починил.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { promptAsksForJson } from '../ai-router/json-mode';
import { RELIGION_SUGGESTION_SYSTEM_PROMPT } from '../onboarding/onboarding.service';

const SRC = join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      sources(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Просит ли ЭТОТ системный промпт формат — тем же вопросом и в той же
 * форме, в какой его задаёт роутер. Общая машинерия ключевого теста и
 * обратной пробы: иначе проба проверяла бы соседнее выражение, а сторож
 * [probe-checked-the-neighbour] завёден ровно на этот случай. */
const asksForFormat = (systemPrompt: string) => promptAsksForJson(systemPrompt, 'Страна: Польша.');

describe('Пункт [json-mode-was-asked-and-dropped] 2026-09-26: мера по дереву', () => {
  const files = sources(SRC)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter((f) => f.text.includes('jsonMode: true'));
  const sites = files.reduce((n, f) => n + f.text.split('jsonMode: true').length - 1, 0);

  it('МЕРА: сколько вызовов просят JSON и в скольких сервисах', () => {
    // Числа точные, и это мера, а не правило: вырастут они — значит
    // появились новые вызовы, и стоит посмотреть, какому провайдеру они
    // достанутся. Приблизительная граница («> 50») не заметила бы, что
    // разбор молча усох до нуля и все проверки ниже стали пустыми.
    expect(sites).toBe(87);
    expect(files.length).toBe(65);
  });

  it('МЕРА: жёсткий режим есть ровно у одного клиента из трёх, и это видно из кода', () => {
    // Перекос — суть пункта: флаг ставят 87 раз, а читает его один
    // клиент. Проверяется не комментарий, а объявленное поле.
    const clients = readFileSync(join(SRC, 'ai-router', 'ai-provider-client.ts'), 'utf8');
    const gemini = readFileSync(join(SRC, 'ai-router', 'gemini-client.ts'), 'utf8');
    const declarations = [...clients.matchAll(/jsonModeSupport = '([a-z-]+)'/g)].map((m) => m[1]);
    const geminiDeclaration = [...gemini.matchAll(/jsonModeSupport = '([a-z-]+)'/g)].map((m) => m[1]);
    expect([...declarations, ...geminiDeclaration].sort()).toEqual([
      'enforced',
      'prompt-only',
      'prompt-only',
    ]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: единственный вызов, просивший формат ОДНИМ флагом, теперь просит его словами', () => {
    // Подсказка религии в онбординге: `jsonMode: true` плюс
    // validateOutput, и ни слова про формат в промпте. На провайдере без
    // жёсткого режима модель вернула бы прозу, валидация не прошла бы,
    // и человек увидел бы ровно то же, что при «модели нечего
    // предложить» — пустое поле без объяснения.
    //
    // Проверяется САМ промпт, а не файл рядом с ним, и той же функцией,
    // которой пользуется роутер: вернётся формулировка без требования
    // формата — тест покраснеет.
    expect(asksForFormat(RELIGION_SUGGESTION_SYSTEM_PROMPT)).toBe(true);
    // И требование именно жёсткое, а не «желательно бы JSON»: формат
    // указан вместе с формой объекта, иначе разбирать нечего.
    expect(RELIGION_SUGGESTION_SYSTEM_PROMPT.includes('"suggestedReligion"')).toBe(true);
  });

  it('обратная проба: сама функция умеет говорить «нет» — иначе предыдущий тест ничего не значит', () => {
    expect(asksForFormat('осторожная подсказка про страну')).toBe(false);
  });
});
