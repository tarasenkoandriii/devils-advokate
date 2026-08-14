import Image from 'next/image';
import { Dictionary } from '../lib/i18n/dictionary';

// Пункт: текстовые оверлеи прямо на иллюстрации цикла разговора
// (conversation_cycle_bindings.json, координаты пикселей на канвасе
// 1536×1024). Позиции — ЦЕНТР bbox каждого текстового блока (не
// top-left, в отличие от Technology.tsx) — сам JSON явно указывает
// align:"center" для всех текстовых слоёв, поэтому здесь используется
// transform: translate(-50%, -50%), не translateY(-50%) как в
// Technology. "anchor" в исходном JSON у stage-элементов указывает на
// позицию ИКОНКИ рядом с текстом, не сам текст — использован bbox
// (центр реального прямоугольника текста), не anchor, для stage-
// заголовков/описаний и центрального текста. У pipeline-элементов
// (верхняя строка) bbox не задан вообще, только anchor — используется
// anchor как есть.
//
// cycle_title ЧЕСТНО ПРОПУЩЕН — дублирует уже существующий <h2>
// секции (расположенный НАД картинкой, не поверх неё), а его
// bbox (y:168-212 из 1024) физически попадает в зону, где на самой
// иллюстрации уже находятся круги-аватары 1/2 — наложение текста
// поверх них выглядело бы плохо, не просто избыточно.
const STAGE_POSITIONS = [
  // 1 и 2 — измерено программно: нижний край кольца обеих аватарок
  // ~40.2-40.3% высоты канваса, старое значение 37.7% ещё перекрывало
  // фото; новое — с запасом ниже, буквально под аватаркой, не поверх неё.
  { labelTop: 43.5, descTop: 49, left: 39.97 }, // 1: PREPARE
  { labelTop: 43.5, descTop: 49, left: 59.38 }, // 2: TALK
  { labelTop: 60.64, descTop: 65.63, left: 66.08 }, // 3: CLARIFY
  { labelTop: 78.42, descTop: 83.59, left: 36.59 }, // 4: ANALYZE
  { labelTop: 79.2, descTop: 83.98, left: 56.05 }, // 5: LEARN & ACT
];

// Центр — сдвинут ближе к радиальному центру композиции (к самому
// микрофону), по прямому запросу. Кольцо микрофона на реальном
// изображении измерено программно (сканирование ярких зелёных
// пикселей по вертикали): от 37.3% до 58.7% высоты канваса, центр
// ~48% — старое значение 60.25% (из исходного JSON-биндинга) сидело
// уже ЗА нижним краем кольца, не "ближе к центру". Новое значение
// 55% — внутри/у самого нижнего края кольца, ощутимо ближе, чем было.
const CENTER_POSITION = { top: 55, left: 49.87 };

// Цвета pipeline-элементов — измерены программно с реального
// изображения (не приближение на глаз): цвет кольца каждой иконки
// (яркие пиксели окантовки), не приглушённый цвет пунктирной линии
// под ней (та полупрозрачная, даёт зашумлённый через JPEG результат).
// Итоговые оттенки — чистые версии того же цветового семейства, не
// сырые сэмплированные значения (JPEG-сжатие давало смещённые в серый
// оттенки). Позиция текста — на месте самой пунктирной линии-
// "артефакта" под иконкой (измерено: ~11-13% высоты канваса у разных
// иконок, взято среднее 12.5%), не на месте самой иконки (было
// 8.59% — прямо поверх пиктограммы).
const PIPELINE_LEFT = [23.11, 36.46, 49.35, 62.17, 73.18, 84.05];
// Шрифт увеличен (10px→13px) и позиция сдвинута вниз на половину
// высоты шрифта (~6.5px = 0.76% высоты канваса 853px) — по прямому
// запросу: пунктирная линия-"артефакт" шире тёмной подложки текста,
// более крупный шрифт даёт более широкую подложку (max-content),
// сдвиг вниз точнее центрирует её на самой линии.
const PIPELINE_TOP = 13.3;
const PIPELINE_COLORS = ['#7ed957', '#4fc3f7', '#4fc3f7', '#c084fc', '#f0a94e', '#7ed957'];

export function CycleSteps({ dict }: { dict: Dictionary }) {
  return (
    <section className="section cycle">
      <div className="container">
        <p className="eyebrow">{dict.cycle.eyebrow}</p>
        <h2 className="cycle__title">{dict.cycle.title}</h2>

        <div className="cycle__image-wrap">
          <Image
            src="/images/cycle.jpg"
            alt=""
            width={1280}
            height={853}
            className="cycle__image"
            sizes="(max-width: 900px) 100vw, 1200px"
          />

          {dict.cycle.overlay.stages.map((stage, i) => {
            const pos = STAGE_POSITIONS[i];
            if (!pos) return null;
            return [
              <span
                key={`${stage.label}-label`}
                className="cycle__overlay-label"
                style={{ top: `${pos.labelTop}%`, left: `${pos.left}%` }}
              >
                {stage.label}
              </span>,
              <span
                key={`${stage.label}-desc`}
                className="cycle__overlay-desc"
                style={{ top: `${pos.descTop}%`, left: `${pos.left}%` }}
              >
                {stage.description}
              </span>,
            ];
          })}

          <div className="cycle__overlay-center" style={{ top: `${CENTER_POSITION.top}%`, left: `${CENTER_POSITION.left}%` }}>
            {dict.cycle.overlay.center}
          </div>

          {dict.cycle.overlay.pipeline.map((item, i) => (
            <span
              key={item}
              className="cycle__overlay-pipeline"
              style={{ top: `${PIPELINE_TOP}%`, left: `${PIPELINE_LEFT[i]}%`, color: PIPELINE_COLORS[i] }}
            >
              {item}
            </span>
          ))}
        </div>

        <ol className="cycle__list">
          {dict.cycle.steps.map((step, i) => (
            <li key={step.title} className="cycle__step">
              <span className="cycle__index">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="cycle__step-title">{step.title}</h3>
              <p className="cycle__step-desc">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
