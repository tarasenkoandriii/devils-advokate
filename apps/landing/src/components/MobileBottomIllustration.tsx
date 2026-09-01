import Image from 'next/image';

// Показывается ТОЛЬКО на мобильных (<768px, см. globals.css), в самом
// конце документа — после Footer, не fixed/sticky. На десктопе роль
// адвоката играет sticky-illustration--bottom-right в Hero.tsx (весь
// скролл лендинга), здесь — по прямому запросу вернуть иллюстрацию
// "в самом низу вёрстки" на мобильных, то есть один раз, в потоке
// документа, а не закреплённой поверх контента.
export function MobileBottomIllustration() {
  return (
    <div className="mobile-only-illustration mobile-only-illustration--bottom" aria-hidden="true">
      <Image
        src="/images/hero-lawyer.webp"
        alt=""
        width={1672}
        height={941}
        className="mobile-only-illustration__image"
        sizes="(min-width: 768px) 0px, 100vw"
      />
    </div>
  );
}
