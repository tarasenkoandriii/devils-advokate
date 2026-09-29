'use client';

// Полный аудит 2026-08-30 — юридические ссылки по домену. Backend
// (LegalDisclaimerService, seed по юрисдикции) существовал с Пункта
// [legal-disclaimer], манифест доменов оставил под него слот
// disclaimerKey, но ни одна страница его не вызывала.
import { useEffect, useState } from 'react';
import { getLegalDisclaimer } from '../../lib/features';
import type { LegalDisclaimerResponse } from '../../lib/types';
import { SectionLoadError } from '../SectionLoadError';
import { projectModeForDomain } from '../../lib/domains/project-mode';

export function DomainLegalDisclaimer({ domainId }: { domainId: string }) {
  const [data, setData] = useState<LegalDisclaimerResponse | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  // Аудит 2026-09-03: сбой загрузки просто убирал блок с юридическими
  // ориентирами со страницы. Отсутствие блока неотличимо от «в этом
  // домене законом ничего не регулируется» — а это самая дорогая из
  // возможных подмен: человек принимает решение, считая, что норм нет.
  const [failed, setFailed] = useState(false);
  // Домен без режима теперь невозможен по типу, но если он всё-таки
  // придёт (кривой параметр маршрута), молчать нельзя: молчание здесь
  // читается так же, как читалось раньше — «закон ничего не регулирует».
  const [unknownDomain, setUnknownDomain] = useState(false);
  useEffect(() => {
    // Пункт [domain-not-mapped] 2026-09-06: здесь была рукописная
    // таблица на шесть доменов из восьми, и для двух пропущенных блок
    // не появлялся молча. Соответствие теперь одно на весь продукт и
    // exhaustive по типу.
    const mode = projectModeForDomain(domainId);
    if (!mode) { setUnknownDomain(true); setData(null); return; }
    setUnknownDomain(false);
    getLegalDisclaimer(mode)
      .then((d) => { setData(d); setFailed(false); })
      .catch(() => { setData(null); setFailed(true); });
  }, [domainId]);
  if (failed) return <SectionLoadError what="юридические ориентиры по этому домену" hint="закон тут ничего не регулирует" />;
  if (unknownDomain) {
    return (
      <p className="dtp-status dtp-status--warn" role="status">
        Юридические ориентиры для этого раздела продукт не запрашивал — раздел не связан ни с одним режимом проекта.
        Это пробел продукта, а не признак того, что закон тут ничего не регулирует.
      </p>
    );
  }
  if (!data) return null;

  // Пункт [silent-jurisdiction] 2026-09-06: здесь стояло `if (!data)
  // return null` — и для 28 пар «домен + юрисдикция» из 32 блок
  // исчезал целиком, включая ДТП и семейное право в Украине. Теперь
  // сервер не возвращает пустоту, а называет пробел, и экран его
  // показывает.
  const notResearched = data.coverage === 'not-researched' || data.references.length === 0;

  if (notResearched) {
    return (
      <details className="dtp-card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="dtp-card__head" style={{ cursor: 'pointer' }}>
          ⚖️ Что говорит закон ({data.bucket}) — ссылки не собраны
        </summary>
        <div className="dtp-card__body">
          {/* Спокойный факт о продукте, а не тревога о законе: пугающий
              флаг «не исследовано, обратитесь к юристу» на каждом экране
              был отвергнут владельцем раньше, и он здесь не появляется. */}
          <p className="dtp-hint" role="status">
            Для этого домена и юрисдикции ({data.bucket}) ссылки на нормы в продукт не собраны. Это пробел продукта,
            а не признак того, что закон тут ничего не регулирует: мы не искали, а не искали и не нашли.
          </p>
        </div>
      </details>
    );
  }

  return (
    <details className="dtp-card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="dtp-card__head" style={{ cursor: 'pointer' }}>
        ⚖️ Что говорит закон ({data.bucket}) — {data.references.length} ссылк{data.references.length === 1 ? 'а' : data.references.length < 5 ? 'и' : ''}
      </summary>
      <div className="dtp-card__body">
        <p className="dtp-hint">Это не юридическая консультация — только ориентиры, какие нормы обычно применимы.</p>
        {/* Пункт [silent-jurisdiction] 2026-09-06: здесь стояло
            «проверено {дата}» и обещание «если старше года —
            перепроверьте». Никто ничего не проверял в этот день: это
            дата, когда норму вписали в продукт, и у всех ссылок она
            одна и та же. Процесса перепроверки у продукта нет, и
            обещать его порогом «год» — значит успокаивать вместо того,
            чтобы сказать возраст. */}
        <p className="dtp-status dtp-status--warn" role="status">
          Внесено в продукт{typeof data.seededDaysAgo === 'number' ? ` ${Math.floor(data.seededDaysAgo / 30)} мес. назад` : ''}.
          Это дата записи, а не проверки: с тех пор нормы никто не сверял с источником. Перед тем как на них опереться,
          откройте источник сами.
        </p>
        {data.references.map((r, i) => (
          <div key={i} style={{ width: '100%' }}>
            <strong>{r.actName}</strong> <span className="dtp-muted">· {r.citation}</span>
            <p style={{ margin: '4px 0' }}>{r.summary}</p>
            <span className="dtp-muted">вписано {new Date(r.seededAt).toLocaleDateString('ru-RU')}{r.sourceUrl && <> · <a href={r.sourceUrl} target="_blank" rel="noreferrer">источник</a></>}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
