// Пункт [job-domain-v2] §3.5 / §13.5 — словарь норм для compliance-проверки
// текста вакансии (А-14). Версионируется датой. Номера норм показываются в
// интерфейсе ТОЛЬКО при LEGAL_REFERENCES_CONFIRMED=true — до подтверждения
// юристом флаг формулируется нейтрально (приёмка 32). Так конфигурационный
// зазор не выглядит отказом, а юридический риск не ждёт релиза.

export const LEGAL_NORMS_VERSION = '2026-09-02';

export interface LegalNorm {
  key: string;
  /** нейтральная формулировка — показывается всегда */
  neutral: string;
  /** ссылка на норму — только за гейтом */
  reference: string;
  jurisdiction: 'UA' | 'EU' | 'ANY';
}

export const LEGAL_NORMS: Record<string, LegalNorm> = {
  UA_ADVERTISING_PROTECTED: {
    key: 'UA_ADVERTISING_PROTECTED',
    neutral: 'В объявлении о вакансии не указывают возраст, пол, расу, цвет кожи, убеждения, членство в профсоюзах, происхождение, имущественное положение, место жительства и язык (кроме установленных законом случаев).',
    reference: 'Україна, ст. 24¹ Закону «Про рекламу»',
    jurisdiction: 'UA',
  },
  EU_PAY_TRANSPARENCY: {
    key: 'EU_PAY_TRANSPARENCY',
    neutral: 'Работодатель сообщает начальный уровень или диапазон оплаты в объявлении или до собеседования и не спрашивает кандидата о прошлой зарплате.',
    reference: 'ЄС, Директива 2023/970 про прозорість оплати праці (транспозиція до 7 червня 2026)',
    jurisdiction: 'EU',
  },
  UA_LANGUAGE: {
    key: 'UA_LANGUAGE',
    neutral: 'Публичное объявление в Украине должно иметь версию на государственном языке.',
    reference: 'Україна, Закон «Про забезпечення функціонування української мови як державної»',
    jurisdiction: 'UA',
  },
  PROXY: {
    key: 'PROXY',
    neutral: 'Формулировка косвенно указывает на защищённый признак (например, «молодой коллектив», «без семейных обязательств»).',
    reference: '—',
    jurisdiction: 'ANY',
  },
};

export function legalReferencesConfirmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEGAL_REFERENCES_CONFIRMED === 'true';
}

/** Как показывать норму: нейтрально всегда, ссылка — только за гейтом. */
export function presentNorm(key: string | null | undefined, env: NodeJS.ProcessEnv = process.env): { normKey: string | null; normText: string | null; normReference?: string } {
  const norm = key ? LEGAL_NORMS[key] : undefined;
  if (!norm) return { normKey: null, normText: null };
  const out: { normKey: string; normText: string; normReference?: string } = { normKey: norm.key, normText: norm.neutral };
  if (legalReferencesConfirmed(env) && norm.reference !== '—') out.normReference = norm.reference;
  return out;
}
