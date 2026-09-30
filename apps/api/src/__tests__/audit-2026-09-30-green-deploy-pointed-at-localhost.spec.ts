// Пункт [green-deploy-pointed-at-localhost] 2026-09-30 — адрес API
// берётся в одном месте на приложение, и на платформе его отсутствие —
// отказ, а не localhost.
//
// НАЙДЕННОЕ. `process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000'`
// стояло восемь раз в `apps/tma` и девятый в `apps/admin`. Переменная
// читается на СБОРКЕ (`NEXT_PUBLIC_` вкомпилируется в бандл), поэтому
// её отсутствие на платформе означает не «возьми дефолт», а «в бандле
// у всех людей стои́т localhost их собственного браузера»: сборка
// зелёная, деплой зелёный, страницы рисуются, ни одной записи в логах
// функции — потому что до функции ничего не доходит.
//
// ЧТО СТОРОЖИТСЯ ЗДЕСЬ. Не поведение функции — оно проверяется там, где
// она живёт (`apps/tma/src/__tests__/cut-off-was-called-malformed.spec.ts`),
// — а ДВЕ вещи, которые проверяются только снаружи обоих приложений:
// что прежний дефолт нигде не остался копией, и что две копии правила
// (два отдельных приложения Next без общего пакета) не разъехались.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const MONOREPO = join(__dirname, '..', '..', '..', '..');
const COPIES = ['apps/tma/src/lib/api-base-url.ts', 'apps/admin/src/lib/api-base-url.ts'];
const INLINE_DEFAULT = "process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000'";

function read(rel: string): string {
  return readFileSync(join(MONOREPO, rel), 'utf8');
}

/** Код без комментариев.
 *
 *  Первая версия этой сверки насчитала четыре нарушения и все четыре
 *  были КОММЕНТАРИЯМИ: файлы, закрывающие дефект, цитируют прежнее
 *  выражение в объяснении, зачем их написали. Сверка, считающая
 *  комментарии кодом, требует не писать о найденном — в проекте, где
 *  найденное обязано быть названо рядом с правкой. Эта ловушка сработала
 *  в один день шесть раз, и потому чистка здесь не деталь. */
function code(rel: string): string {
  return stripComments(read(rel));
}

function stripComments(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (state === 'code') {
      if (two === '//') { state = 'line'; i++; continue; }
      if (two === '/*') { state = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; out += c; continue; }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
    } else if (state === 'block') {
      if (two === '*/') { state = 'code'; i++; }
    } else {
      if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (c === state) state = 'code';
      out += c;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

describe('Пункт [green-deploy-pointed-at-localhost]: адрес API — одно место на приложение', () => {
  it('КЛЮЧЕВОЕ ПРАВИЛО: прежнего дефолта нет ни в одном файле обоих приложений', () => {
    const offenders: string[] = [];
    for (const app of ['tma', 'admin']) {
      for (const file of sourceFiles(join(MONOREPO, 'apps', app, 'src'))) {
        if (stripComments(readFileSync(file, 'utf8')).includes(INLINE_DEFAULT)) {
          offenders.push(file.slice(MONOREPO.length + 1));
        }
      }
    }
    // Девятая копия появляется одной строкой и ничего не ломает
    // немедленно — именно так их стало девять.
    expect(offenders).toEqual([]);
  });

  it('обе копии правила проверяют одни и те же признаки платформы', () => {
    for (const copy of COPIES) {
      const src = code(copy);
      // Пункт [the-bundler-does-not-read-variables] 2026-09-30 — правка
      // поверх правки, найденная НА ЖИВОМ ДЕПЛОЕ уже после зелёной
      // сборки. Первая версия принимала окружение параметром и читала
      // `env.NEXT_PUBLIC_API_BASE_URL`; сборщик подставляет значение
      // только в БУКВАЛЬНЫЙ текст `process.env.ИМЯ`, поэтому на сервере
      // (пререндер, проверка предела) всё работало и сборка проходила, а
      // в браузере значение снова было undefined и адрес снова падал на
      // localhost. Зелёная сборка проверяла серверную половину, ломалась
      // клиентская. Отсюда правило: ссылки СТАТИЧЕСКИЕ.
      expect(src.includes('process.env.NEXT_PUBLIC_API_BASE_URL')).toBe(true);
      expect(src.includes('process.env.VERCEL ?? ')).toBe(true);
      expect(src.includes('process.env.VERCEL_ENV ?? ')).toBe(true);
      // Ни одного чтения через переменную-окружение: именно его сборщик
      // и не подставляет.
      expect(/[^.]\benv\.NEXT_PUBLIC_API_BASE_URL\b/.test(src)).toBe(false);
      expect(/[^.]\benv\.VERCEL\b/.test(src)).toBe(false);
      expect(src.includes('NodeJS.ProcessEnv')).toBe(false);
      // Признак — платформа, а НЕ NODE_ENV: локальная сборка и CI идут
      // с NODE_ENV=production, и по нему правило роняло бы сборку там,
      // где дефолт разработки как раз уместен.
      expect(src.includes('NODE_ENV')).toBe(false);
      // Отказ называет имя переменной: сообщение без имени не говорит
      // оператору, что выставить.
      expect(src.includes('NEXT_PUBLIC_API_BASE_URL не выставлена')).toBe(true);
      // И дефолт разработки остаётся дефолтом разработки.
      expect(src.includes("export const LOCAL_API_BASE_URL = 'http://localhost:3000'")).toBe(true);
    }
  });

  it('обе копии снимают хвостовой слэш — иначе склейка даёт //path', () => {
    for (const copy of COPIES) {
      expect(code(copy).includes("raw.replace(/\\/+$/, '')")).toBe(true);
    }
  });

  it('вторая копия названа копией и указывает на первую — иначе они разъедутся молча', () => {
    const admin = read('apps/admin/src/lib/api-base-url.ts');
    expect(admin.includes('apps/tma/src/lib/api-base-url.ts')).toBe(true);
  });

  it('оба клиентских слоя берут адрес из общего места, а не собирают сами', () => {
    for (const rel of ['apps/tma/src/lib/api.ts', 'apps/tma/src/lib/public-api.ts', 'apps/tma/src/lib/features.ts', 'apps/admin/src/lib/admin-api.ts']) {
      const src = read(rel);
      expect(src.includes("from './api-base-url'")).toBe(true);
    }
  });
});
