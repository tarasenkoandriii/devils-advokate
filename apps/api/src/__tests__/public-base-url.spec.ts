// 2026-08-31 — тесты разбора API_PUBLIC_BASE_URL.
//
// Каждый сценарий — реальный способ испортить это значение, а не
// выдуманный. Общее у них то, что симптом ОДИН И ТОТ ЖЕ и максимально
// неинформативный: разговор навсегда виснет в TRANSCRIBING, потому что
// вебхук с результатом ушёл не туда. Именно поэтому проверка стоит до
// отправки задачи провайдеру: отказ с текстом лучше молча потерянного
// job'а, за который вдобавок уже заплачено.

import { publicApiBaseUrl } from '../common/public-base-url';

const env = (value?: string) => ({ API_PUBLIC_BASE_URL: value }) as NodeJS.ProcessEnv;

describe('publicApiBaseUrl', () => {
  it('нормальный адрес возвращается как есть', () => {
    expect(publicApiBaseUrl(env('https://my-api.vercel.app'))).toBe('https://my-api.vercel.app');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: слэш на конце срезается — иначе в пути вебхука появляется двойной слэш', () => {
    // Самый частый способ испортить значение: скопировать адрес из
    // адресной строки браузера, где слэш стоит всегда.
    expect(publicApiBaseUrl(env('https://my-api.vercel.app/'))).toBe('https://my-api.vercel.app');
    expect(publicApiBaseUrl(env('https://my-api.vercel.app///'))).toBe('https://my-api.vercel.app');
  });

  it('пробелы по краям не мешают', () => {
    expect(publicApiBaseUrl(env('  https://my-api.vercel.app/  '))).toBe('https://my-api.vercel.app');
  });

  it('не задано или пусто — понятная ошибка, а не undefined в URL вебхука', () => {
    expect(() => publicApiBaseUrl(env(undefined))).toThrow(/is not set/);
    expect(() => publicApiBaseUrl(env('   '))).toThrow(/is not set/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: адрес с путём отвергается — почти всегда это скопированный не тот URL', () => {
    // Ровно та ошибка, ради которой проверка и написана: в переменную
    // кладут адрес страницы админки или TMA вместо корня API.
    expect(() => publicApiBaseUrl(env('https://admin.vercel.app/login'))).toThrow(/содержит путь/);
    expect(() => publicApiBaseUrl(env('https://api.vercel.app/api'))).toThrow(/содержит путь/);
  });

  it('http:// на публичном домене отвергается — по этому адресу возвращается расшифровка разговора', () => {
    expect(() => publicApiBaseUrl(env('http://my-api.example.com'))).toThrow(/https/);
  });

  it('http://localhost разрешён — локальная разработка, снаружи он всё равно недостижим', () => {
    expect(publicApiBaseUrl(env('http://localhost:3000'))).toBe('http://localhost:3000');
    expect(publicApiBaseUrl(env('http://127.0.0.1:3000/'))).toBe('http://127.0.0.1:3000');
  });

  it('не URL вовсе — честное «не разбирается», без догадок', () => {
    expect(() => publicApiBaseUrl(env('my-api.vercel.app'))).toThrow(/не разбирается как URL/);
  });
});
