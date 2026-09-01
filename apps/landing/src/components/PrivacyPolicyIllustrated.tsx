import Image from 'next/image';
import { Dictionary } from '../lib/i18n/dictionary';

// Последняя секция лендинга (по прямому запросу) — иллюстрированная
// версия Privacy Policy, отдельная от короткой PrivacySection (§3.4
// ТЗ, короткие 3 пункта раньше на странице). Изображение
// (privacy-policy.png) содержит ТОЧНЫЕ координаты пиктограмм
// (privacy_policy_en.json, anchor: {x, y} в долях от размера картинки
// для каждого пункта) — не пришлось вычислять вручную через PIL/scipy,
// как для technology.png.
//
// ЧЕСТНО про расхождение источника: JSON заявляет 48 пунктов в 9
// группах, но собственный аудит внутри того же файла говорит
// "pictogram_entries: 39" — и это правда: у групп bottom_capture_analysis
// (5 пунктов) и bottom_guidance_review (4 пункта) нет ни одной видимой
// пиктограммы на самой картинке (проверено обрезкой области их anchor'ов,
// y≈0.775 — там только хвост центральной композиции). Эти 9 пунктов не
// переведены и не рендерятся — нечего к ним привязывать без пиктограммы.
//
// ВТОРОЙ ПРОХОД ПО СТИЛЮ — по референсу с реальным текстом
// (file_000000008f7c81f484f2b80d5dc39ec4.png, тот же композиционный
// концепт, другой рендер с самим текстом на месте). Оттуда — три
// конкретных стилевых решения, не увиденных на "no text" версии:
// 1) заголовки ВСЕ ЗАГЛАВНЫЕ, жирные (в первой версии — обычный regular
//    текст, отсюда и жалоба "подписи не получились хорошо");
// 2) у центрального круга (8 узлов) и нижней строки в референсе ЕСТЬ
//    описание под заголовком — у левой колонки и правой ЕГО НЕТ, только
//    заголовок. Не универсальное правило "всегда компактно" из первого
//    прохода — под каждую группу свой формат, как в референсе;
// 3) у центрального круга — нумерованные бейджи (1-8) на самих иконках,
//    которых не было вообще.
// Правая колонка в референсе — БЕЗ подписей вовсе (пустые плашки) — по
// прямому указанию для неё используются уже переведённые из JSON
// подписи (Documents/Tables & Reports/...), просто оформленные в этом
// же стиле, не выдуманные с нуля повторно.
type Direction = 'right' | 'left' | 'above' | 'below';

interface AnchorConfig {
  x: number;
  y: number;
  dir: Direction;
  maxWidth: number; // px — подобран под реальный промежуток до соседней иконки в этой группе
  showDesc?: boolean; // только central_network и bottom_security_controls, как в референсе
  badge?: number; // номер 1-8 — только central_network
  badgeOffset?: { x: number; y: number }; // px — сдвиг бейджа от иконки, подобран так, чтобы НЕ попадать на текст лейбла (который уходит в направлении dir)
  fontSize?: number; // px — переопределяет дефолтный 11px; сейчас используется только для left_workflow
  offsetX?: number; // px — точный сдвиг ТОЛЬКО текстового блока (не иконки/якоря), по прямому запросу
  offsetY?: number; // px — то же самое по вертикали
}

const ANCHORS: Record<string, AnchorConfig> = {
  // left_workflow — на самой картинке РОВНО 5 иконок в этой рамке
  // (щит-галочка / замок / человек / растущий график / глобус с
  // листом), не 6 — проверено прямым просмотром колонки без наложенного
  // текста. Прежняя версия накладывала 6 лейблов из JSON
  // (workflow_prepare...workflow_privacy) на эти 5 иконок — 6-й
  // (workflow_privacy) либо садился поверх 5-й иконки, либо уезжал в
  // пустой хвост рамки. Реальная ошибка привязки, не вопрос стиля.
  //
  // Правильные подписи для этих 5 иконок уже были в присланном раньше
  // референсе с текстом (тот же композиционный концепт) — "PRIVACY
  // FIRST / SECURE BY DEFAULT / YOU OWN YOUR DATA / FULL CONTROL AT
  // ALL TIMES / RESPONSIBLE BY NATURE" — взяты оттуда буквально, не
  // придуманы заново. workflow_privacy убран из ANCHORS (не рендерится
  // — нет 6-й иконки, к которой его привязывать), но данные в словаре
  // не удалены — тот же паттерн, что уже применялся к
  // bottom_capture_analysis/bottom_guidance_review.
  // Y-координаты — центр ИМЕННО ИКОНКИ (не всей строки-плашки с
  // дефисной линией и отступами) — измерено отдельно: узкая полоса по
  // X=55-115 (там, где рисуется сама графика иконки), верх/низ засветки
  // выше порога 25% максимума. Первая версия координат брала центр
  // всей строки целиком (row-level детекция) — давало систематическое
  // расхождение 1-11px с истинным центром иконки, из-за чего блок
  // текста визуально не совпадал по центру с иконкой, хоть и был
  // "центрирован" формально (translateY(-50%) относительно неточной
  // точки). Шрифт также уменьшен (15px → 13px) по прямому запросу.
  // Повторная правка: пользователь визуально указал, что НИЗ блока
  // текста оказывается на уровне центра иконки, не середина блока —
  // проверено отладочной линией на скриншоте (Playwright bounding_box +
  // наложение маркера через PIL). Математически transform:
  // translateY(-50%) центрирует блок корректно НА ЗАДАННУЮ Y-точку —
  // но сама точка (измеренный "центр иконки" с порогом 25% от
  // максимума яркости) оказалась ниже истинного визуального центра:
  // мягкое неоновое свечение под иконкой (более яркое снизу у части
  // иконок) тянуло расчётную нижнюю границу вниз сильнее, чем
  // отражает реальная графика. Скорректировано вручную — сдвиг вверх
  // на ~0.012 (≈12px из 1024) для всех 5 пунктов. Шрифт также уменьшен
  // (13px → 12px) по прямому запросу.
  // Третья правка — точный пиксельный сдвиг ТОЛЬКО текстового блока
  // (offsetX/offsetY), не трогая сами Y/X-координаты (которые остаются
  // привязкой к истинному центру иконки) — по прямому запросу: ниже на
  // 30px, левее на 10px. Шрифт уменьшен третий раз (12px → 10px).
  //
  // Четвёртая правка — maxWidth сужен до РОВНО того значения, при
  // котором ВСЕ 5 текстов переносятся на 3 строки одновременно, не
  // на глаз: прогнан подбор через Playwright по сетке ширин (55-100px
  // с шагом 5, затем уточнение по 1px в найденном промежутке),
  // измерялась фактическая высота каждого отрендеренного span и
  // делилась на line-height. При шрифте 10px единственное значение —
  // 82px. Пятая правка (шрифт чуть крупнее — 10px → 11px, сдвиг правее
  // на 25px — offsetX: -10 → 15) потребовала пересчёта: при 11px то же
  // самое подобранное на глаз 82px даёт [3,3,4,3,3] — уже не подходит,
  // при бо́льшем кегле буквы шире, строка вмещает меньше символов.
  // Единственное значение для 11px — 90px (найдено тем же перебором).
  //
  // Шестая правка: шрифт 11px → 10.5px (заново пересчитан maxWidth —
  // 86px, единственное значение с результатом [3,3,3,3,3] при этом
  // кегле), сдвиг влево на 5px (offsetX: 15 → 10). Пункты 3-5
  // (workflow_guidance/capture/review) дополнительно сдвинуты вниз
  // ещё на 20px (offsetY: 30 → 50) — пункты 1-2 остаются на 30px.
  //
  // Седьмая правка: шрифт 10.5px → 10px (значение maxWidth=82px для
  // этого кегля уже было найдено ранее в этой же серии правок —
  // перепроверено тем же Playwright-перебором, подтвердилось без
  // изменений), сдвиг вправо на 5px (offsetX: 10 → 15).
  workflow_prepare: {
    x: 0.062,
    y: 0.1457,
    dir: 'right',
    maxWidth: 82,
    fontSize: 10,
    offsetX: 15,
    offsetY: 30,
  },
  workflow_live: {
    x: 0.062,
    y: 0.2678,
    dir: 'right',
    maxWidth: 82,
    fontSize: 10,
    offsetX: 15,
    offsetY: 30,
  },
  workflow_guidance: {
    x: 0.062,
    y: 0.3689,
    dir: 'right',
    maxWidth: 82,
    fontSize: 10,
    offsetX: 15,
    offsetY: 50,
  },
  workflow_capture: {
    x: 0.062,
    y: 0.4856,
    dir: 'right',
    maxWidth: 82,
    fontSize: 10,
    offsetX: 15,
    offsetY: 50,
  },
  workflow_review: {
    x: 0.062,
    y: 0.6027,
    dir: 'right',
    maxWidth: 82,
    fontSize: 10,
    offsetX: 15,
    offsetY: 50,
  },

  // top_pipeline — этого ряда нет в референсе вообще (более простая
  // 8-узловая версия композиции), но он есть на рабочей картинке —
  // оставлен компактным, тесное место по Y до central_home.
  // pipeline_deliver сужен (100 вместо 110) и сдвинут по факту рендера
  // — иначе наезжал на attachment_documents в правом верхнем углу
  // (два независимых столкновения на стыке групп, не увиденных
  // раньше — там раньше не было отдельных описаний, из-за которых
  // проблема стала заметна только сейчас).
  pipeline_capture: { x: 0.255, y: 0.078, dir: 'below', maxWidth: 110 },
  pipeline_noise: { x: 0.378, y: 0.078, dir: 'below', maxWidth: 110 },
  pipeline_transcribe: { x: 0.513, y: 0.078, dir: 'below', maxWidth: 110 },
  pipeline_understand: { x: 0.621, y: 0.078, dir: 'below', maxWidth: 110 },
  pipeline_generate: { x: 0.731, y: 0.078, dir: 'below', maxWidth: 110 },
  pipeline_deliver: { x: 0.8, y: 0.078, dir: 'below', maxWidth: 95 },

  // central_network — 8 узлов по кругу, нумерация 1-8 совпадает с
  // порядком обхода по референсу (сверху, по часовой стрелке).
  // badgeOffset подобран ПРОТИВОПОЛОЖНО направлению текста (dir) —
  // если текст уходит "above", бейдж — правее иконки, не выше, иначе
  // они гарантированно накладываются друг на друга (найдено рендером:
  // первая версия с единой формулой сдвига для всех badge посадила
  // "1" прямо в середину заголовка central_home).
  // central_home — направление "below" (не "above", как остальные
  // верхние подписи) НАМЕРЕННО: сверху всего ~90px до строки
  // pipeline_transcribe ("SPEECH RECOGNITION"), которая тоже тянется
  // вниз к этой же зоне — при "above" с описанием (нужно ~77px высоты)
  // текст central_home гарантированно накладывался на "SPEECH
  // RECOGNITION". Вниз, к центру композиции — пространство свободно
  // (~190px до телефона), только декоративные линии-соединители, не
  // текст. Найдено и исправлено только повторным рендером.
  central_home: {
    x: 0.507,
    y: 0.166,
    dir: 'below',
    maxWidth: 150,
    showDesc: true,
    badge: 1,
    badgeOffset: { x: 34, y: 0 },
  },
  central_lock: {
    x: 0.667,
    y: 0.259,
    dir: 'right',
    maxWidth: 130,
    showDesc: true,
    badge: 2,
    badgeOffset: { x: 0, y: -34 },
  },
  central_user: {
    x: 0.667,
    y: 0.456,
    dir: 'right',
    maxWidth: 130,
    showDesc: true,
    badge: 3,
    badgeOffset: { x: 0, y: -34 },
  },
  central_shield: {
    x: 0.667,
    y: 0.644,
    dir: 'right',
    maxWidth: 130,
    showDesc: true,
    badge: 4,
    badgeOffset: { x: 0, y: -34 },
  },
  central_delete: {
    x: 0.505,
    y: 0.739,
    dir: 'below',
    maxWidth: 140,
    showDesc: true,
    badge: 5,
    badgeOffset: { x: 34, y: 0 },
  },
  central_verified_doc: {
    x: 0.334,
    y: 0.644,
    dir: 'left',
    maxWidth: 130,
    showDesc: true,
    badge: 6,
    badgeOffset: { x: 0, y: -34 },
  },
  central_cloud_block: {
    x: 0.334,
    y: 0.456,
    dir: 'left',
    maxWidth: 130,
    showDesc: true,
    badge: 7,
    badgeOffset: { x: 0, y: -34 },
  },
  central_settings: {
    x: 0.333,
    y: 0.259,
    dir: 'left',
    maxWidth: 130,
    showDesc: true,
    badge: 8,
    badgeOffset: { x: 0, y: -34 },
  },

  // right_attachments, right_processing — в референсе пустые, здесь —
  // уже переведённые из JSON подписи, оформлены в общем стиле,
  // компактно (шаг между иконками всего ~63-69px по Y).
  attachment_documents: { x: 0.893, y: 0.071, dir: 'right', maxWidth: 130 },
  attachment_tables: { x: 0.893, y: 0.133, dir: 'right', maxWidth: 130 },
  attachment_images: { x: 0.893, y: 0.196, dir: 'right', maxWidth: 130 },
  attachment_audio_video: { x: 0.893, y: 0.258, dir: 'right', maxWidth: 130 },
  attachment_links: { x: 0.893, y: 0.32, dir: 'right', maxWidth: 130 },
  processing_extract: { x: 0.893, y: 0.402, dir: 'right', maxWidth: 130 },
  processing_index: { x: 0.893, y: 0.468, dir: 'right', maxWidth: 130 },
  processing_link: { x: 0.893, y: 0.535, dir: 'right', maxWidth: 130 },
  processing_use: { x: 0.893, y: 0.602, dir: 'right', maxWidth: 130 },

  // right_sources_trust — самая тесная группа, шахматное чередование
  // above/below сохранено из предыдущего прохода (реально исправило
  // склейку текста, найдено рендером).
  source_public: { x: 0.838, y: 0.665, dir: 'below', maxWidth: 60 },
  source_private: { x: 0.883, y: 0.665, dir: 'above', maxWidth: 60 },
  source_ai: { x: 0.927, y: 0.665, dir: 'below', maxWidth: 60 },
  source_assumption: { x: 0.969, y: 0.665, dir: 'above', maxWidth: 65 },

  // bottom_security_controls — в референсе ЕСТЬ описание (просторнее
  // по X, ~215-260px между иконками, хватает места).
  // bottom_security_controls — по прямому запросу: описание (мелкий
  // шрифт) убрано целиком (showDesc снят), крупный ЗАГЛАВНЫЙ заголовок
  // сдвинут правее на 20px и ниже на 15px (offsetX/offsetY).
  control_offline: { x: 0.06, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
  control_encryption: { x: 0.199, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
  control_storage: { x: 0.361, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
  control_share: { x: 0.532, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
  control_integrations: { x: 0.711, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
  control_growth: { x: 0.87, y: 0.934, dir: 'above', maxWidth: 140, offsetX: 20, offsetY: 15 },
};

export function PrivacyPolicyIllustrated({ dict }: { dict: Dictionary }) {
  return (
    <section className="section privacy-policy-illustrated" id="privacy-policy">
      <div className="container">
        <p className="eyebrow">{dict.privacyPolicy.eyebrow}</p>
        <h2 className="privacy-policy-illustrated__title">{dict.privacyPolicy.title}</h2>
        <p className="lede privacy-policy-illustrated__subtitle">{dict.privacyPolicy.subtitle}</p>

        <div className="privacy-policy-illustrated__image-wrap">
          <Image
            src="/images/privacy-policy.webp"
            alt={dict.privacyPolicy.title}
            width={1536}
            height={1024}
            className="privacy-policy-illustrated__image"
            sizes="(max-width: 900px) 100vw, 1300px"
          />

          {dict.privacyPolicy.groups.map((group) =>
            group.items.map((item) => {
              const anchor = ANCHORS[item.id];
              if (!anchor) return null; // пункты без видимой пиктограммы — не рендерятся, см. комментарий выше
              return (
                <div
                  key={item.id}
                  className={`privacy-policy-illustrated__label privacy-policy-illustrated__label--${anchor.dir}${anchor.showDesc ? ' privacy-policy-illustrated__label--with-desc' : ''}`}
                  style={{
                    left: `${anchor.x * 100}%`,
                    top: `${anchor.y * 100}%`,
                    maxWidth: `${anchor.maxWidth}px`,
                    marginLeft: anchor.offsetX ? `${anchor.offsetX}px` : undefined,
                    marginTop: anchor.offsetY ? `${anchor.offsetY}px` : undefined,
                  }}
                >
                  <span
                    className="privacy-policy-illustrated__label-text"
                    style={anchor.fontSize ? { fontSize: `${anchor.fontSize}px` } : undefined}
                  >
                    {item.text}
                  </span>
                  {anchor.showDesc && (
                    <span className="privacy-policy-illustrated__label-desc">{item.description}</span>
                  )}
                </div>
              );
            }),
          )}

          {/* Нумерованные бейджи центрального круга — отдельный слой.
           * badgeOffset (px) сдвигает бейдж В СТОРОНУ, ПРОТИВОПОЛОЖНУЮ
           * направлению текста лейбла (dir) — иначе бейдж садится
           * поверх заголовка/описания, как было в первой версии. */}
          {Object.entries(ANCHORS)
            .filter(([, a]) => a.badge)
            .map(([id, a]) => (
              <span
                key={`badge-${id}`}
                className="privacy-policy-illustrated__badge"
                style={{
                  left: `${a.x * 100}%`,
                  top: `${a.y * 100}%`,
                  marginLeft: `${a.badgeOffset?.x ?? 0}px`,
                  marginTop: `${a.badgeOffset?.y ?? 0}px`,
                }}
              >
                {a.badge}
              </span>
            ))}
        </div>
      </div>
    </section>
  );
}
