import { Dictionary } from '../lib/i18n/dictionary';

// Второй проход после первой сломанной попытки (см. git-историю/README):
// причина поломки была в использовании `padding` в процентах для
// вертикальных отступов — в CSS ЛЮБОЙ процент в padding (включая
// padding-top/bottom) считается от ШИРИНЫ containing block, никогда от
// высоты, даже если контейнер — узкий высокий телефон. При боксе
// ~172×383px это схлопывало всю вертикальную раскладку в кашу.
//
// Исправление — `flex: 0 0 X%` (flex-basis) вместо `padding: X%`:
// flex-basis в процентах внутри flex-direction:column действительно
// считается от высоты контейнера (это его прямое назначение, main-axis
// sizing), не от ширины. Пропорции секций сняты с реального замера
// экрана телефона на референсе (525px высоты): статус-бар/заголовок/
// waveform/4 строки/чек-лист/тулбар — конкретные доли даны как
// flex-grow ниже, подобраны по факту вертикальным замерам, не на глаз.
//
// Иконки — настоящий inline SVG (не заглушки-квадраты, как в первой
// версии), минимальный line-style, подобранный визуально по референсу:
// щит (заголовок/строка 3), треугольник-восклицание (строка 1),
// лампочка (строка 2), прицел (строка 4), микрофон/документ/флаг
// (тулбар).
//
// Задумано для последующего использования как основа "живого" экрана
// приложения (не только статичная иллюстрация) — структура компонента
// (секции с фиксированными пропорциями, переиспользуемые SVG-иконки)
// рассчитана на то, чтобы позже принимать реальные пропсы (список
// сигналов, состояние чек-листа) вместо текущих фиксированных
// демо-значений, не только на то, чтобы один раз отрендериться здесь.

function ShieldIcon({ checkmark }: { checkmark?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5 4.5 5.5v5.8c0 5.4 3.4 9.9 7.5 11.2 4.1-1.3 7.5-5.8 7.5-11.2V5.5L12 2.5z" />
      {checkmark && <path d="M8.5 12.2l2.2 2.2 4.3-4.3" />}
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5 2.5 20.5h19L12 3.5z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 18.5h5M10.2 21.5h3.6" />
      <path d="M12 2.5a6.2 6.2 0 0 0-3.8 11.1c.6.5 1.2 1.6 1.3 2.9h5c.1-1.3.7-2.4 1.3-2.9A6.2 6.2 0 0 0 12 2.5z" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <line x1="12" y1="1.5" x2="12" y2="4.5" />
      <line x1="12" y1="19.5" x2="12" y2="22.5" />
      <line x1="1.5" y1="12" x2="4.5" y2="12" />
      <line x1="19.5" y1="12" x2="22.5" y2="12" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="17.5" x2="12" y2="21" />
      <line x1="8.5" y1="21" x2="15.5" y2="21" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2.5h8l5 5v14H6v-19z" />
      <path d="M14 2.5v5h5" />
      <line x1="9" y1="13" x2="16" y2="13" />
      <line x1="9" y1="16.5" x2="16" y2="16.5" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="2.5" x2="5" y2="21.5" />
      <path d="M5 4.5h14l-3 4 3 4H5" />
    </svg>
  );
}

const ROWS = [
  { color: 'red', time: '00:18:35', icon: <AlertIcon /> },
  { color: 'amber', time: '00:18:37', icon: <LightbulbIcon /> },
  { color: 'green', time: '00:18:40', icon: <ShieldIcon checkmark /> },
  { color: 'blue', time: '00:18:41', icon: <TargetIcon /> },
] as const;

const AGENDA_STATES = ['checked', 'checked', 'selected', 'empty', 'empty'] as const;

// Границы экрана телефона внутри technology.png — те же координаты,
// что использовались при композитинге растра (см. Technology.tsx),
// на случай, если этот компонент позже вернётся в основную композицию
// как реальный (не растровый) слой.
const PHONE_BOUNDS = { left: 26.7, top: 17.1, width: 15.3, height: 51.3 };

export function PhoneMockup({ dict }: { dict: Dictionary }) {
  return (
    <div
      className="phone-mockup"
      style={{
        left: `${PHONE_BOUNDS.left}%`,
        top: `${PHONE_BOUNDS.top}%`,
        width: `${PHONE_BOUNDS.width}%`,
        height: `${PHONE_BOUNDS.height}%`,
      }}
      aria-hidden="true"
    >
      <div className="phone-mockup__status-bar">
        <span>9:41</span>
      </div>

      <div className="phone-mockup__header">
        <span className="phone-mockup__shield">
          <ShieldIcon />
        </span>
        <span className="phone-mockup__brand">Devil&apos;s Advocate</span>
        <span className="phone-mockup__live">{dict.technologyPhone.liveLabel}</span>
      </div>

      <div className="phone-mockup__waveform">
        <span className="phone-mockup__waveform-bars" aria-hidden="true">
          {Array.from({ length: 28 }).map((_, i) => (
            <span key={i} style={{ height: `${20 + ((i * 37) % 60)}%` }} />
          ))}
        </span>
        <span className="phone-mockup__waveform-time">00:18:42</span>
      </div>

      <div className="phone-mockup__rows">
        {ROWS.map((row) => (
          <div key={row.time} className={`phone-mockup__row phone-mockup__row--${row.color}`}>
            <span className="phone-mockup__row-icon">{row.icon}</span>
            <span className="phone-mockup__row-time">{row.time}</span>
            <span className="phone-mockup__row-chevron">›</span>
          </div>
        ))}
      </div>

      <div className="phone-mockup__agenda">
        <span className="phone-mockup__agenda-label">{dict.technologyPhone.currentAgendaLabel}</span>
        <div className="phone-mockup__agenda-list">
          {AGENDA_STATES.map((state, i) => (
            <span key={i} className={`phone-mockup__agenda-item phone-mockup__agenda-item--${state}`} />
          ))}
        </div>
      </div>

      <div className="phone-mockup__toolbar">
        <span className="phone-mockup__toolbar-icon phone-mockup__toolbar-icon--mic">
          <MicIcon />
        </span>
        <span className="phone-mockup__toolbar-icon">
          <DocIcon />
        </span>
        <span className="phone-mockup__toolbar-icon">
          <FlagIcon />
        </span>
      </div>
    </div>
  );
}
