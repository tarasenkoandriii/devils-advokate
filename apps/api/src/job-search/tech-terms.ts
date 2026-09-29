// Словарь технологий/инструментов, вынесенный из job-search-tools.service.ts
// аудитом 2026-09-03: тот же список нужен второму барьеру — проверке, что
// переформулировка фрагмента CV не притащила навык, которого у человека нет.
//
// Список заведомо неполный и таким и задуман: он ловит частые случаи, а не
// претендует на «все технологии мира». Барьер, построенный на нём, работает
// в одну сторону — найденное чужое слово точно чужое; ненайденное не
// означает «чисто». Поэтому он дополняет проверку по числам и по словарю
// самого CV, а не заменяет её.
export const TECH_TERMS = [
  'python', 'java', 'kotlin', 'swift', 'go', 'golang', 'rust', 'c++', 'c#', '.net',
  'node.js', 'nodejs', 'react', 'vue', 'angular', 'typescript', 'javascript', 'sql',
  'postgresql', 'mysql', 'mongodb', 'redis', 'kafka', 'docker', 'kubernetes', 'k8s',
  'aws', 'gcp', 'azure', 'terraform', 'django', 'flask', 'spring', 'php', 'laravel',
  'ruby', 'rails', '1c', '1с', 'sap', 'salesforce', 'hubspot', 'bitrix', 'битрикс',
  'excel', 'power bi', 'tableau', 'figma', 'photoshop', 'autocad', 'solidworks',
];

/** Есть ли термин в тексте как отдельное слово (а не внутри другого). */
export function mentionsTerm(text: string, term: string): boolean {
  const re = new RegExp(`(^|[^a-zа-я0-9.+#])${term.replace(/[.+#]/g, '\\$&')}(?=$|[^a-zа-я0-9])`, 'i');
  return re.test(text.toLowerCase());
}
