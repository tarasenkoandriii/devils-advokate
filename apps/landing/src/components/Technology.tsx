import Image from 'next/image';
import { Dictionary } from '../lib/i18n/dictionary';

// PhoneMockup.tsx НЕ удалён из проекта, но и не используется здесь —
// первая HTML-реконструкция экрана телефона сломалась в рендере
// (классическая CSS-ловушка: проценты в padding считаются от ШИРИНЫ
// контейнера, даже для верхнего/нижнего отступа — не от высоты; при
// узком высоком боксе телефона это схлопнуло всю вертикальную
// раскладку). Вместо починки — по прямому решению — содержимое экрана
// перенесено растром прямо в technology.png (композитинг из референса
// с текстом, см. README): переводить там всё равно нечего, кроме
// таймстемпов (числа, не текст) и "Devil's Advocate" (имя бренда, не
// переводится нигде на сайте). PhoneMockup.tsx можно re-visit позже,
// если понадобится версия с реально переводимым содержимым экрана.

// Текст наложен поверх изображения, привязан к позиции каждой
// пиктограммы. Координаты СНЯТЫ ВРУЧНУЮ с изображения — JSON-биндинги
// (we_are_not_en.json) содержат только связку иконка→текст, БЕЗ
// координат вообще.
//
// ВТОРОЙ ПРОХОД ПО КООРДИНАТАМ — по референсу с реальным текстом
// (не той версии, что использовалась для первого прохода, где текста
// не было вообще). Первая версия координат центрировала текст по пику
// яркости ИКОНКИ — а иконка сидит ближе к верху плашки, не в её
// истинном центре, поэтому весь текст визуально "плыл вверх" (замечено
// пользователем, подтверждено пересчётом: разница доходила до 34px).
// Исправлено — координаты теперь берутся из суммарной яркости ПО ВСЕЙ
// ШИРИНЕ плашки (включая текст референса), что даёт истинный центр
// плашки, не только центр иконки внутри неё.
//
// ЦЕНТР ТЕЛЕФОНА — референс с текстом показал, что на самом телефоне
// НЕТ текстовых подписей вообще (только таймстемпы) — семантика каждой
// строки (Risk alert/Suggestion/...) передаётся ТОЛЬКО через левую и
// правую колонки callout'ов, не дублируется на телефоне. Поэтому
// dict.technology.groups[1] (center_phone_risks) больше не рендерится
// как текстовый оверлей вообще — данные остаются в словаре (переведены
// на 3 языка), просто не выводятся на экран. Экран телефона теперь —
// отдельный компонент PhoneMockup, реальный HTML, не часть этого файла.
const POSITIONS = {
  left: [
    { top: 15.2 },
    { top: 26.9 },
    { top: 38.5 },
    { top: 49.9 },
    { top: 61.3 },
    { top: 72.8 },
  ].map((p) => ({ ...p, left: 7.5, maxWidth: 8.5 })),
  right: [
    { top: 14.6 },
    { top: 26.8 },
    { top: 38.5 },
    { top: 50.0 },
    { top: 61.5 },
    { top: 72.9 },
    // left увеличен с 77.5 до 79.5 — чуть больше горизонтального
    // отступа от иконки, по прямому запросу.
  ].map((p) => ({ ...p, left: 79.5, maxWidth: 17 })),
  bottom: [
    { left: 9.1 },
    { left: 26.2 },
    { left: 40.6 },
    { left: 58.5 },
    { left: 74.2 },
    { left: 89.5 },
  ].map((p) => ({ ...p, top: 84.3, maxWidth: 10.5 })),
};

// Индекс группы в dict.technology.groups -> ключ позиций. Группа с
// индексом 1 (center_phone_risks) намеренно отсутствует в этой карте —
// см. комментарий выше про то, почему она больше не рендерится.
const GROUP_POSITION_KEYS: Record<number, keyof typeof POSITIONS> = {
  0: 'left',
  2: 'right',
  3: 'bottom',
};
const COMPACT_GROUPS: Array<keyof typeof POSITIONS> = ['bottom'];

export function Technology({ dict }: { dict: Dictionary }) {
  return (
    <section className="section technology" id="technology">
      <div className="container">
        <p className="eyebrow">{dict.technology.eyebrow}</p>
        <h2 className="technology__title">{dict.technology.title}</h2>
        <p className="lede technology__subtitle">{dict.technology.subtitle}</p>

        <div className="technology__image-wrap">
          <Image
            src="/images/technology.png"
            alt={dict.technology.title}
            width={1536}
            height={1024}
            className="technology__image"
            sizes="(max-width: 900px) 100vw, 1200px"
          />

          {dict.technology.groups.map((group, groupIndex) => {
            const positionKey = GROUP_POSITION_KEYS[groupIndex];
            if (!positionKey) return null;
            const positions = POSITIONS[positionKey];
            const isCompact = COMPACT_GROUPS.includes(positionKey);

            return group.items.map((item, itemIndex) => {
              const pos = positions[itemIndex];
              if (!pos) return null;
              return (
                <div
                  key={`${group.title}-${item.text}`}
                  className={`technology__overlay-item${isCompact ? ' technology__overlay-item--compact' : ''}`}
                  style={{
                    top: `${pos.top}%`,
                    left: `${pos.left}%`,
                    maxWidth: `${pos.maxWidth}%`,
                  }}
                >
                  <span className="technology__overlay-text">{item.text}</span>
                  {!isCompact && (
                    <span className="technology__overlay-desc">{item.description}</span>
                  )}
                </div>
              );
            });
          })}
        </div>
      </div>
    </section>
  );
}
