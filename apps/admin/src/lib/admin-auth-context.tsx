'use client';

// Пункт [admin-panel]: клиентская сессия (см. структуру ТЗ §3,
// src/lib/admin-auth.ts). AdminSession — httpOnly cookie, JS не может
// прочитать сам token — состояние "залогинен ли я" узнаётся ТОЛЬКО
// через реальный запрос GET /admin/auth/me (401 = не залогинен или
// сессия истекла), не через чтение cookie на клиенте.

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getMe, logout as logoutRequest } from './endpoints';
import { ApiRequestError } from './admin-api';
import type { AdminMe } from './types';

interface AdminAuthState {
  me: AdminMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMe();
      setMe(result);
    } catch (err) {
      setMe(null);
      // 401/сессия истекла или отсутствует — честный редирект на
      // /login, не молчаливый показ пустых данных (acceptance-тест
      // §5.1, второй сценарий, devils-advocate-admin-panel-tz.md).
      if (err instanceof ApiRequestError && pathname !== '/login') {
        router.replace('/login');
      }
    } finally {
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest();
    setMe(null);
    router.replace('/login');
  }, [router]);

  return (
    <AdminAuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) {
    throw new Error('useAdminAuth must be used within AdminAuthProvider');
  }
  return ctx;
}
