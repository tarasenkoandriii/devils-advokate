'use client';

// ТЗ §0 — DomainProjectsList: список проектов домена (фаза A, GET
// <domain>/projects) + создание по question (+ поля манифеста, напр.
// contractType у семейного права) + доменное согласие (health).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { getManifest } from '../../../lib/domains/manifests';
import { domainApi, DomainProjectItem } from '../../../lib/domains/api';
import { EntityForm } from '../../../components/domains/EntityForm';
import { DomainConsentGate } from '../../../components/domains/DomainConsentGate';
import { DomainLegalDisclaimer } from '../../../components/domains/DomainLegalDisclaimer';
import { useBackButton } from '../../../hooks/useBackButton';

export default function DomainProjectsPage() {
  const params = useParams<{ domain: string }>();
  const router = useRouter();
  const manifest = getManifest(params.domain);
  const [items, setItems] = useState<DomainProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useBackButton(() => router.push('/domains'));

  useEffect(() => {
    if (!manifest) return;
    domainApi.listProjects(manifest)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, [manifest]);

  if (!manifest) return <main className="page"><p className="generation-error">Неизвестный сценарий.</p><Link href="/domains">← Сценарии</Link></main>;

  const fields = [{ name: 'question', label: 'Опишите ситуацию одной фразой', type: 'textarea' as const, required: true }, ...(manifest.createProjectFields ?? [])];

  const body = (
    <>
      {creating ? (
        <EntityForm fields={fields} submitLabel="Создать" onCancel={() => setCreating(false)}
          onSubmit={async (v) => { const p = await domainApi.createProject(manifest, v); router.push(`/domains/${manifest.id}/${p.id}`); }} />
      ) : (
        <button type="button" className="primary" onClick={() => setCreating(true)}>+ Новый проект · {manifest.title}</button>
      )}
      {loading && <p>Загрузка…</p>}
      {error && <p className="generation-error">{error}</p>}
      {!loading && items.length === 0 && <p className="card-section__empty">Пока нет проектов в этом сценарии.</p>}
      <ul className="project-list">
        {items.map((p) => (
          <li key={p.id}><Link href={`/domains/${manifest.id}/${p.id}`}>
            <span className="project-list__question">{p.question}</span>
            <span className="project-list__meta">{new Date(p.updatedAt).toLocaleDateString()}</span>
          </Link></li>
        ))}
      </ul>
    </>
  );

  return (
    <main className="page">
      <h1>{manifest.icon} {manifest.title}</h1>
      <p className="card-section__empty">{manifest.tagline}</p>
      <DomainLegalDisclaimer domainId={manifest.id} />
      {manifest.requiredConsent ? <DomainConsentGate consentType={manifest.requiredConsent}>{body}</DomainConsentGate> : body}
    </main>
  );
}
