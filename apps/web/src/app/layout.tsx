import type { Metadata } from 'next';
import { createTranslator } from '@homestay/shared';
import { LocaleProvider } from '@/components/LocaleProvider';
import { getLocale } from '@/lib/i18n';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return {
    title: t('app.name'),
    description: t('app.tagline'),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale}>
      <head>
        {/* Loaded via <link> rather than next/font so the build never needs network access. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+Khmer:wght@400;500;600&display=swap"
        />
      </head>
      <body className="min-h-screen antialiased">
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
