// Пункт [ai-locale] 2026-09-02 — язык ответа AI.
//
// Найдено живым прогоном песочницы: разбор украинского видео вернулся
// русскоязычному оператору по-английски. Язык ответа не задавался
// нигде: промпты написаны по-русски, но это инструкция модели, а не
// требование к языку вывода — без явного требования модель следует
// языку входных данных.
import {
  DEFAULT_AI_RESPONSE_LANGUAGE,
  aiResponseLanguageInstruction,
  languageName,
  normalizeLanguageCode,
  withResponseLanguage,
} from '../common/ai-response-language';

describe('normalizeLanguageCode', () => {
  it('берёт базовый тег: Telegram присылает и ru, и ru-RU', () => {
    expect(normalizeLanguageCode('ru')).toBe('ru');
    expect(normalizeLanguageCode('ru-RU')).toBe('ru');
    expect(normalizeLanguageCode('pt_BR')).toBe('pt');
    expect(normalizeLanguageCode('UK')).toBe('uk');
  });

  it('мусор и пустое — null, чтобы сработал дефолт, а не «язык ответа: 12»', () => {
    expect(normalizeLanguageCode(undefined)).toBeNull();
    expect(normalizeLanguageCode(null)).toBeNull();
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('  ')).toBeNull();
    expect(normalizeLanguageCode('12')).toBeNull();
    expect(normalizeLanguageCode('русский')).toBeNull();
  });
});

describe('languageName', () => {
  it('называет язык так, как он называет себя сам — модель точнее следует', () => {
    expect(languageName('ru')).toBe('русский');
    expect(languageName('uk')).toBe('українська');
    expect(languageName('en')).toBe('English');
  });

  it('неизвестный код отдаётся как есть, а не подменяется дефолтом', () => {
    expect(languageName('sv')).toBe('sv');
  });
});

describe('aiResponseLanguageInstruction', () => {
  const instruction = aiResponseLanguageInstruction('ru');

  it('называет язык и кодом, и словом', () => {
    expect(instruction).toContain('русский');
    expect(instruction).toContain('(ru)');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: требует язык НЕЗАВИСИМО от языка входных данных', () => {
    // Ровно найденный случай: украинский транскрипт, русскоязычный
    // пользователь. Без этой оговорки модель отвечает по языку входа.
    expect(instruction).toContain('НЕЗАВИСИМО от языка входных данных');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: запрещает переводить JSON-ключи, enum-значения и идентификаторы', () => {
    // Не украшение, а условие работоспособности: почти все промпты
    // проекта требуют строгого JSON с константами вроде SUPPORTED и с
    // segmentId. Переведи их модель — validateOutput отверг бы ответ, и
    // фича упала бы на «exhausted all attempts» вместо чужого языка.
    expect(instruction).toContain('ключи JSON');
    expect(instruction).toContain('SUPPORTED');
    expect(instruction).toContain('segmentId');
    expect(instruction).toContain('URL');
    expect(instruction).toContain('цитаты');
  });
});

describe('withResponseLanguage', () => {
  it('дописывает инструкцию к существующему промпту, не затирая его', () => {
    const result = withResponseLanguage('Ты помогаешь подготовиться к разговору.', 'uk');
    expect(result).toContain('Ты помогаешь подготовиться к разговору.');
    expect(result).toContain('українська');
    // Промпт идёт первым: инструкция про язык — дополнение к задаче.
    expect(result.indexOf('Ты помогаешь')).toBeLessThan(result.indexOf('ЯЗЫК ОТВЕТА'));
  });

  it('без системного промпта отдаёт одну инструкцию, без пустых строк в начале', () => {
    const result = withResponseLanguage(undefined, 'en');
    expect(result.startsWith('ЯЗЫК ОТВЕТА')).toBe(true);
  });

  it('дефолт — русский: интерфейс приложения русский', () => {
    expect(DEFAULT_AI_RESPONSE_LANGUAGE).toBe('ru');
  });
});
