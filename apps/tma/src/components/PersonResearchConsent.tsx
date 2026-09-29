'use client';

// Пункт [consent-that-could-not-be-given] 2026-09-24 — экран, которого
// не было.
//
// Тип согласия `PERSON_RESEARCH` лежал в схеме и в типах клиента, а
// спросить его было НЕГДЕ: ни одной кнопки, ни одного экрана. Решение
// владельца (§16.0 ТЗ) — «исследование человека только через отдельный
// контур» — исполнить было нечем.
//
// Один компонент на все три разбора, а не три текста: в продукте уже
// есть запись о том, чем кончаются разрозненные формулировки одного и
// того же согласия (LocationConsentPrompt, Пункт 77: «один экран
// согласия, а не разрозненные пуш-запросы в разных местах»).

import { useState } from 'react';
import { ApiRequestError } from '../lib/api';
import { grantConsent } from '../lib/features';
import { haptic } from '../lib/telegram';

export const PERSON_RESEARCH_CONSENT_VERSION = 'v1';

/** Опознаётся по устойчивому коду и типу, а не по подстроке в тексте:
 * текст сообщения не контракт (Пункт [error-language] 2026-09-04). */
export function isPersonResearchConsentNeeded(err: unknown): boolean {
  return (
    err instanceof ApiRequestError &&
    err.code === 'CONSENT_REQUIRED' &&
    (err.details as { consentType?: string } | undefined)?.consentType === 'PERSON_RESEARCH'
  );
}

/** Что показать после отказа: вопрос о согласии или сообщение об
 * ошибке. Общая функция, а не три одинаковых `if` по экранам: копии
 * одной заботы разъезжаются — это в продукте уже разбиралось. */
export function consentOrError(err: unknown, fallback: string): { consentNeeded: true } | { message: string } {
  if (isPersonResearchConsentNeeded(err)) return { consentNeeded: true };
  return { message: err instanceof Error && err.message.trim() ? err.message : fallback };
}

interface Props {
  /** Откуда спросили — уходит в запись согласия, чтобы потом было
   * видно, на каком экране человек это решал. */
  source: string;
  onGranted: () => void;
}

/** Отдельной функцией, а не строкой внутри обработчика: так «просит
 * ИМЕННО это согласие» проверяется вызовом, а не чтением исходника.
 * `grant` подменяем в проверке — сам компонент всегда зовёт настоящий. */
export async function grantPersonResearchConsent(source: string, grant = grantConsent): Promise<void> {
  await grant({ consentType: 'PERSON_RESEARCH', version: PERSON_RESEARCH_CONSENT_VERSION, source });
}

export function PersonResearchConsent({ source, onGranted }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant() {
    setSaving(true);
    setError(null);
    try {
      await grantPersonResearchConsent(source);
      haptic('success');
      onGranted();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить согласие');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="person-research-consent" role="group" aria-label="Согласие на разбор о человеке">
      <p className="person-research-consent__title">Это разбор О ЧЕЛОВЕКЕ — нужно отдельное согласие</p>
      {/* Прямо о том, что здесь неприятного: предмет — не ваш вопрос, а
          другой человек, и он об этом не знает. Успокоительная
          формулировка на экране согласия — последнее, что можно себе
          позволить (см. ConsentGate, Пункт [consent-purpose]). */}
      <p className="person-research-consent__body">
        Продукт разберёт то, что <strong>вы сами</strong> рассказали об этом человеке, и составит выводы о нём:
        как он вёл себя раньше, как он обычно разговаривает, какими могут быть его мотивы. Это догадки на ваших
        словах, а не сведения из открытых источников: продукт никого не разыскивает.
      </p>
      <p className="person-research-consent__body">
        Сам человек согласия не давал и возразить не может — поэтому решение остаётся за вами и спрашивается
        отдельно от согласия на работу с AI. Отозвать можно в Центре приватности; уже собранные сведения
        останутся, их удаление — отдельная кнопка там же.
      </p>
      <button type="button" onClick={handleGrant} disabled={saving} className="person-research-consent__button">
        {saving ? 'Сохраняем…' : 'Разрешить разборы о людях'}
      </button>
      {error && <p className="person-research-consent__error" role="alert">{error}</p>}
    </div>
  );
}
