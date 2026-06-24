import Image from 'next/image';

/** Tenri AI Logo — 派蒙 */
export function CatCafeLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <Image
      src="/icons/paimon-logo.png"
      alt="Tenri AI Logo"
      width={40}
      height={40}
      className={className}
      priority
    />
  );
}
