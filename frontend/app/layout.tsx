import type { Metadata } from 'next';
import { Nunito, Nunito_Sans, Halant } from 'next/font/google';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

const nunitoSans = Nunito_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-nunito-sans',
  display: 'swap',
});

// Used as a web-safe substitute for Avenir Next Rounded Pro on headings.
const nunito = Nunito({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-nunito',
  display: 'swap',
});

const halant = Halant({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-halant',
  display: 'swap',
});


export const metadata: Metadata = {
  title: 'CPCQC Engagement Tracker',
  description:
    'Track hospital engagement across CPCQC perinatal quality-improvement initiatives.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${nunitoSans.variable} ${nunito.variable} ${halant.variable}`}
    >
      <body className="min-h-screen bg-cpcqc-cream text-[#2a2536] antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
