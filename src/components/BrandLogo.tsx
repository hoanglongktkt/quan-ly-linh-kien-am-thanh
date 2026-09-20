import { APP_TITLE, APP_TAGLINE, LOGO_PNG } from '../config/brand';

type BrandLogoProps = {
  size?: number;
  className?: string;
};

export default function BrandLogo({ size = 40, className = '' }: BrandLogoProps) {
  return (
    <img
      src={LOGO_PNG}
      alt="LA Audio"
      width={size}
      height={size}
      className={`block object-contain shrink-0 bg-white ${className}`}
      style={{ width: size, height: size, maxWidth: size, maxHeight: size }}
    />
  );
}

type BrandHeaderProps = {
  titleClassName?: string;
  taglineClassName?: string;
  logoSize?: number;
};

export function BrandHeader({
  titleClassName = 'font-extrabold text-sm text-white tracking-tight leading-tight',
  taglineClassName = 'text-[10px] font-bold text-slate-400 uppercase tracking-widest',
  logoSize = 40,
}: BrandHeaderProps) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BrandLogo size={logoSize} className="rounded-lg bg-white" />
      <div className="min-w-0">
        <h1 className={`truncate ${titleClassName}`}>{APP_TITLE}</h1>
        <span className={taglineClassName}>{APP_TAGLINE}</span>
      </div>
    </div>
  );
}
