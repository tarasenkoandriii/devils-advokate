import { Locale } from './config';
import { Dictionary } from './dictionary';
import { en } from './dictionaries/en';
import { uk } from './dictionaries/uk';
import { ru } from './dictionaries/ru';

// Статический импорт всех трёх словарей, не динамический import() —
// при трёх языках и небольшом объёме текста нет практической пользы
// от code-splitting по локали ценой усложнения.
const dictionaries: Record<Locale, Dictionary> = { en, uk, ru };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
