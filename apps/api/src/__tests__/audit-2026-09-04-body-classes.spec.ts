// Сверка тел запросов 2026-09-04 — обещанное продолжение [outside-input].
//
// Тот заход намерил пятнадцать мест, где `@Body()` типизирован
// ИНТЕРФЕЙСОМ, и отложил их отдельной работой с прямой формулировкой:
// «для них ValidationPipe бессилен СТРУКТУРНО (у интерфейса нет метатипа
// в рантайме), сколько декораторов ни пиши». Отложенное закрывается
// здесь.
//
// ПОЧЕМУ ЭТО НЕ КОСМЕТИКА. Интерфейс исчезает при компиляции: Nest
// получает в метатипе `Object`, pipe пропускает тело как есть. То есть
// пятнадцать эндпоинтов были не «слабо проверены», а НЕ ПРОВЕРЯЕМЫ В
// ПРИНЦИПЕ — и никакая будущая разметка это бы не изменила, потому что
// размечать было нечего. Среди них — создание разговора, запрос
// расшифровки (уходит платному провайдеру), факты о человеке, заявка
// заведения, предварительная проверка текста перед отправкой.
//
// ПОЧЕМУ ПЕРЕВОД БЕЗОПАСЕН. TypeScript типизирует структурно: класс без
// приватных полей взаимозаменяем с одноимённым интерфейсом везде, где
// тот использовался, — включая объектные литералы в тестах и вызовы
// сервисов. Интерфейсы заменены классами НА МЕСТЕ; сигнатуры сервисов не
// тронуты, ни один существующий тест не переписан. 1150 тестов API и 764
// standalone прошли неизменёнными — это и есть доказательство, что
// перевод ничего не сдвинул.
//
// ДВА ИСКЛЮЧЕНИЯ, И ОНИ НЕ ЛЕНЬ. Вебхук Telegram и полезная нагрузка
// Login Widget остаются интерфейсами: форма приходит от чужой стороны и
// меняется без нашего участия, а подлинность там обеспечивает не форма
// тела, а секрет в заголовке и HMAC-подпись по всем пришедшим полям.
// Строгая проверка формы означала бы, что очередное расширение чужого
// API молча ломает приём сообщений, — и это тот случай, когда «проверить
// строже» делает хуже. Причины записаны поимённо в
// common/request-body-classes.ts, и тест требует, чтобы у каждого
// оставшегося интерфейсного тела такая запись была.
//
// ЧЕГО ЭТОТ ЗАХОД НЕ ДЕЛАЕТ. Он не приближает включение `whitelist` у
// ValidationPipe: недекорированных DTO-КЛАССОВ в контроллерах
// по-прежнему больше половины (измерение — в [outside-input]), и
// включение вырезало бы у них все поля. Это другая дыра, и смешивать их
// не нужно.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERFACE_BODY_EXCEPTIONS } from '../common/request-body-classes';
import { CreateConversationDto } from '../conversations/dto/create-conversation.dto';
import { RequestTranscriptionDto } from '../conversations/dto/request-transcription.dto';
import { CreatePersonFactInput } from '../person-facts/person-facts.service';
import { PreflightInput } from '../safe-share/safe-share.service';
import { CreateQueueItemInput } from '../media-review/media-review.service';
import { CreateProtectedNoteInput } from '../protected-note/protected-note.service';

const SRC = join(__dirname, '..');

function walk(dir: string, suffix: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full, suffix);
    return name.endsWith(suffix) ? [full] : [];
  });
}

function exportedInterfaces(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(SRC, '.ts')) {
    for (const m of readFileSync(file, 'utf8').matchAll(/export interface (\w+)/g)) names.add(m[1]);
  }
  return names;
}

function interfaceTypedBodies(): Array<{ type: string; file: string }> {
  const interfaces = exportedInterfaces();
  const found: Array<{ type: string; file: string }> = [];
  for (const file of walk(SRC, 'controller.ts')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/@Body\(\)\s*\w+\s*:\s*(\w+)/g)) {
      if (interfaces.has(m[1])) found.push({ type: m[1], file: relative(SRC, file) });
    }
  }
  return found;
}

describe('Тела запросов: проверяемые по определению', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: тело запроса типизировано интерфейсом только там, где это названо и объяснено', () => {
    const unlisted = interfaceTypedBodies()
      .filter((b) => !INTERFACE_BODY_EXCEPTIONS[b.type])
      .map((b) => `${b.type} (${b.file})`);
    expect(unlisted).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого исключения есть причина, а не отметка', () => {
    // Реестр без объяснений — список имён, ради которого его не заводят.
    // Тот же урок, что [guard-audit] вынес из мутации «стереть причину,
    // оставить запись».
    for (const [type, reason] of Object.entries(INTERFACE_BODY_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(80);
      expect(reason).not.toMatch(/^(пока|потом|временно|не успел)/i);
      expect(type).toMatch(/^\w+$/);
    }
    // И реестр не разошёлся с кодом: перечислено ровно то, что осталось.
    const actual = new Set(interfaceTypedBodies().map((b) => b.type));
    const stale = Object.keys(INTERFACE_BODY_EXCEPTIONS).filter((t) => !actual.has(t));
    expect(stale).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (поведение): проверки новых классов действительно срабатывают', async () => {
    // Не «декораторы написаны», а «отвергает то, что должно отвергать»:
    // урок [guard-audit] про проверки на упоминание применён сразу.
    const long = 'а'.repeat(70_000);

    // Разговор: тип-перечисление и дата — не строки «на что похоже».
    expect(await validate(plainToInstance(CreateConversationDto, { sourceType: 'НЕ_ТАКОЙ', occurredAt: '2026-09-04T10:00:00Z' }))).not.toEqual([]);
    expect(await validate(plainToInstance(CreateConversationDto, { sourceType: 'UPLOADED_AUDIO', occurredAt: 'вчера вечером' }))).not.toEqual([]);
    // Сутки с запасом — верхняя граница длительности.
    expect(await validate(plainToInstance(CreateConversationDto, { sourceType: 'UPLOADED_AUDIO', occurredAt: '2026-09-04T10:00:00Z', durationSeconds: 999_999 }))).not.toEqual([]);

    // Расшифровка уходит платному провайдеру — провайдер из списка.
    expect(await validate(plainToInstance(RequestTranscriptionDto, { sttProvider: 'какой-нибудь' }))).not.toEqual([]);
    expect(await validate(plainToInstance(RequestTranscriptionDto, { languageCode: 'это не код языка' }))).not.toEqual([]);

    // Уверенность — доля, а не «сколько не жалко».
    expect(await validate(plainToInstance(CreatePersonFactInput, { content: 'факт', sourceType: 'PERSONAL_RECORD', confidence: 7 }))).not.toEqual([]);
    // Вложенный объект тоже проверяется — без @ValidateNested сюда бы не заглянули.
    expect(
      await validate(plainToInstance(CreatePersonFactInput, { content: 'факт', sourceType: 'PERSONAL_RECORD', source: { url: 'x'.repeat(5000) } })),
    ).not.toEqual([]);

    // Текст перед отправкой — потолок есть.
    expect(await validate(plainToInstance(PreflightInput, { text: long, contentType: 'text/plain' }))).not.toEqual([]);

    // Идентификатор ролика уходит в построение URL — форма важна.
    expect(
      await validate(plainToInstance(CreateQueueItemInput, { youtubeVideoId: 'not-an-id-at-all', title: 'т', channelName: 'к', thumbnailUrl: 'u' })),
    ).not.toEqual([]);

    // Заметка: тип-перечисление обязателен.
    expect(await validate(plainToInstance(CreateProtectedNoteInput, { type: 'ЧТО-ТО', content: 'текст' }))).not.toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (поведение): нормальный ввод проходит — проверка не ломает саму фичу', async () => {
    expect(await validate(plainToInstance(CreateConversationDto, { sourceType: 'UPLOADED_AUDIO', occurredAt: '2026-09-04T10:00:00Z', durationSeconds: 1800 }))).toEqual([]);
    expect(await validate(plainToInstance(RequestTranscriptionDto, { audioUrl: 'https://example.test/a.mp3', languageCode: 'ru', sttProvider: 'soniox' }))).toEqual([]);
    expect(await validate(plainToInstance(CreatePersonFactInput, { content: 'Работает по субботам', sourceType: 'PERSONAL_RECORD', confidence: 0.8, source: { url: 'https://example.test' } }))).toEqual([]);
    expect(await validate(plainToInstance(PreflightInput, { text: 'Короткий текст', contentType: 'text/plain' }))).toEqual([]);
    expect(await validate(plainToInstance(CreateQueueItemInput, { youtubeVideoId: 'dQw4w9WgXcQ', title: 'Ролик', channelName: 'Канал', thumbnailUrl: 'https://example.test/t.jpg' }))).toEqual([]);
    expect(await validate(plainToInstance(CreateProtectedNoteInput, { type: 'ACE_IN_THE_HOLE', content: 'Мой козырь' }))).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько тел запросов осталось интерфейсами', () => {
    // Было пятнадцать (измерение [outside-input]). Осталось два — оба
    // названы и объяснены. Число живёт здесь, чтобы следующая сверка
    // начинала с факта.
    expect(interfaceTypedBodies().length).toBe(2);
    expect(Object.keys(INTERFACE_BODY_EXCEPTIONS)).toHaveLength(2);
  });
});
