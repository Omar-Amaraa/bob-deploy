import logoUrl from '../assets/bob-deploy-logo-transparent.png';

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <img
      className={`brand-logo${compact ? ' brand-logo-compact' : ''}`}
      src={logoUrl}
      alt=""
      aria-hidden="true"
    />
  );
}
