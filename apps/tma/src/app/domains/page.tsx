'use client';

// ТЗ §0 — DomainHub: плитки семи сценариев + вход в голосовой квиз (§2).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DOMAIN_LIST } from '../../lib/domains/manifests';
import { useBackButton } from '../../hooks/useBackButton';

export default function DomainHubPage() {
  const router = useRouter();
  const { isTelegramAvailable } = useBackButton(() => router.push('/'));
  return (
    <main className="page">
      <h1>Сценарии</h1>
      {!isTelegramAvailable && <p><Link href="/">← На главную</Link></p>}
      <p className="card-section__empty">Не знаете, какой подходит? Расскажите голосом — подберём.</p>
      <Link href="/intake" className="domain-tile domain-tile--accent">
        <span className="domain-tile__icon">🎤</span>
        <span><strong>Голосовой квиз</strong><br /><small>Опишите ситуацию — сценарий подберётся сам, данные не придётся вводить повторно</small></span>
      </Link>
      <div className="domain-grid">
        {DOMAIN_LIST.map((m) => (
          <Link key={m.id} href={`/domains/${m.id}`} className="domain-tile">
            <span className="domain-tile__icon">{m.icon}</span>
            <span><strong>{m.title}</strong><br /><small>{m.tagline}</small></span>
          </Link>
        ))}
        <Link href="/media-review" className="domain-tile">
          <span className="domain-tile__icon">🎬</span>
          <span><strong>Разбор медиа</strong><br /><small>Очередь видео/записей публичных дискуссий — сигналы манипуляций и расхождений</small></span>
        </Link>
      </div>
    </main>
  );
}
