import Image from 'next/image';

/** Tenri AI Logo — 派蒙 */
export function CatCafeLogo({
  className = 'w-6 h-6',
  tone = 'gradient',
}: {
  className?: string;
  /** `mono` renders the mark monochrome to blend into currentColor UI (F322 world-rail); API-compatible with upstream SVG variant. */
  tone?: 'gradient' | 'mono';
}) {
  return (
    <Image
      src="/icons/paimon-logo.png"
      alt="Tenri AI Logo"
      width={40}
      height={40}
      className={className}
      style={tone === 'mono' ? { filter: 'grayscale(100%) brightness(0.75)' } : undefined}
      priority
    />
  );
}
