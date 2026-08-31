import type { Metadata } from 'next';
import './globals.css';
import { AdminAuthProvider } from '../lib/admin-auth-context';
import { AdminNav } from '../components/AdminNav';

export const metadata: Metadata = {
  title: "Devil's Advocate — admin",
  robots: { index: false, follow: false }, // внутренний инструмент, не публичная страница
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <AdminAuthProvider>
          <AdminNav />
          {children}
        </AdminAuthProvider>
      </body>
    </html>
  );
}
