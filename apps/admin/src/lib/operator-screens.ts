// Пункт [operator-left-a-trace-unsaid] 2026-09-25 — какие экраны ОБЯЗАНЫ
// предупреждать оператора о следе.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ РЕЕСТР, А НЕ СПИСОК ПРЯМО В JSX. Первая версия сторожа
// искала экраны так: «файл называет обязательное действие — значит он
// операторский». Это круговая проверка: убери вызов компонента вместе с
// именами действий — и экран перестаёт считаться операторским, а сторож
// остаётся зелёным. Мутация «убрать предупреждение с экрана модерации
// библиотеки» её пережила.
//
// Реестр отвечает на другой вопрос — «какие экраны вообще обязаны
// предупреждать», — и ответ на него не должен зависеть от того, стоит ли
// на экране предупреждение. Копией пропсов он при этом не является:
// экран берёт свой список ОТСЮДА, а не пишет второй.

export interface OperatorScreen {
  /** Путь файла экрана от `src/` — по нему сторож его и находит. */
  file: string;
  /** Обязательные к следу действия, которые на нём выполняются. */
  actions: readonly string[];
}

export const OPERATOR_SCREENS: readonly OperatorScreen[] = [
  {
    file: 'app/moderation/users/page.tsx',
    actions: ['user.restricted', 'user.unrestricted', 'user.blocked', 'user.unblocked'],
  },
  {
    file: 'app/moderation/library/page.tsx',
    actions: ['library_entry.moderated'],
  },
  {
    file: 'app/moderation/venues/page.tsx',
    actions: [
      'venue_application.approved',
      'venue_application.rejected',
      'approved_venue.priority_partner_set',
      'approved_venue.referral_fee_set',
    ],
  },
  {
    file: 'app/prompts/[id]/page.tsx',
    actions: ['prompt_version.promoted_to_active', 'prompt_version.rolled_back'],
  },
  {
    file: 'app/domains/[domain]/page.tsx',
    actions: ['admin.project_card.viewed', 'project.frozen', 'project.unfrozen'],
  },
];

/** Действия своего экрана. Экран называет себя один раз, и список берёт
 * отсюда — второй копии не заводится. */
export function operatorScreenActions(file: string): readonly string[] {
  const screen = OPERATOR_SCREENS.find((s) => s.file === file);
  if (!screen) throw new Error(`Экран не описан в реестре операторских экранов: ${file}`);
  return screen.actions;
}
