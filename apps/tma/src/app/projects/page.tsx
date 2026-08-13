'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { listProjects } from '../../lib/features';
import { ProjectListItem } from '../../lib/types';
import { useBackButton } from '../../hooks/useBackButton';

export default function ProjectsPage() {
  const router = useRouter();
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // MVP-фича 4: нативная кнопка "назад" вместо текстовой ссылки —
  // с fallback на ссылку, когда Telegram недоступен (см. ниже в JSX).
  const { isTelegramAvailable } = useBackButton(() => router.push('/'));

  useEffect(() => {
    listProjects()
      .then((res) => setItems(res.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <h1>Мои разговоры</h1>
      {!isTelegramAvailable && (
        <p>
          <Link href="/">← Новый разговор</Link>
        </p>
      )}

      {loading && <p>Загрузка…</p>}
      {error && <p className="generation-error">{error}</p>}

      {!loading && !error && items.length === 0 && <p>Пока нет ни одного проекта.</p>}

      <ul className="project-list">
        {items.map((project) => (
          <li key={project.id}>
            <Link href={`/projects/${project.id}`}>
              <span className="project-list__question">{project.question}</span>
              <span className="project-list__meta">{project._count.arguments} аргументов</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
