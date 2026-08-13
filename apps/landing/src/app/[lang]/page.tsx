import { locales, type Locale } from '../../lib/i18n/config';
import { getDictionary } from '../../lib/i18n/get-dictionary';
import { Hero } from '../../components/Hero';
import { Technology } from '../../components/Technology';
import { CycleSteps } from '../../components/CycleSteps';
import { Differentiation } from '../../components/Differentiation';
import { PrivacySection } from '../../components/PrivacySection';
import { Features } from '../../components/Features';
import { HowItWorks } from '../../components/HowItWorks';
import { FAQ } from '../../components/FAQ';
import { FinalCTA } from '../../components/FinalCTA';
import { PrivacyPolicyIllustrated } from '../../components/PrivacyPolicyIllustrated';
import { Footer } from '../../components/Footer';
import { MobileBottomIllustration } from '../../components/MobileBottomIllustration';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export default function LandingPage({ params }: { params: { lang: Locale } }) {
  const dict = getDictionary(params.lang);

  return (
    <main>
      <Hero dict={dict} lang={params.lang} />
      <Technology dict={dict} />
      <CycleSteps dict={dict} />
      <Differentiation dict={dict} />
      <PrivacySection dict={dict} />
      <Features dict={dict} />
      <HowItWorks dict={dict} />
      <FAQ dict={dict} />
      <FinalCTA dict={dict} />
      {/* Последняя контентная секция перед футером, по прямому запросу —
       * иллюстрированная Privacy Policy, отдельная от короткой
       * PrivacySection выше. */}
      <PrivacyPolicyIllustrated dict={dict} />
      <Footer dict={dict} lang={params.lang} />
      {/* Самый конец документа, буквально "в самом низу вёрстки" —
       * только на мобильных, см. MobileBottomIllustration.tsx. */}
      <MobileBottomIllustration />
    </main>
  );
}
