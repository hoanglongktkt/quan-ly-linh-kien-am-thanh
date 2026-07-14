import { useState } from 'react';
import { APP_TITLE, APP_TAGLINE, LOGO_SVG } from '../config/brand';

type BrandLogoProps = {
  size?: number;
  className?: string;
};

export default function BrandLogo({ size = 40, className = '' }: BrandLogoProps) {
  const [useFallback, setUseFallback] = useState(false);

  return (
    <img
      src={useFallback ? LOGO_SVG : '/logo.png'}
      alt="Logo"
      width={size}
      height={size}
      className={`block object-contain shrink-0 ${className}`}
      style={{ width: size, height: size, maxWidth: size, maxHeight: size }}
      onError={() => {
        if (!useFallback) setUseFallback(true);
      }}
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
      <BrandLogo size={logoSize} className="rounded-xl shadow-md shadow-indigo-500/15 bg-white/5 w-11 h-11" />
      <div className="min-w-0">
        <h1 className={`truncate ${titleClassName}`}>{APP_TITLE}</h1>
        <span className={taglineClassName}>{APP_TAGLINE}</span>
      </div>
    </div>
  );
}
