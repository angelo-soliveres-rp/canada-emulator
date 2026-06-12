import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svgBase(size: number): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  };
}

export function GearIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return (
    <svg {...svgBase(size)} {...p}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 13a1.7 1.7 0 0 0 .34 1.86l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-2.88 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.88-1.2l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 13H4a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.88l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.7 1.7 0 0 0 11 3.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.88 1.2l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05A1.7 1.7 0 0 0 20.4 9H21a2 2 0 0 1 0 4z" />
    </svg>
  );
}
export function ChevronLeftIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M15 6l-6 6 6 6" /></svg>;
}
export function ChevronRightIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M9 6l6 6-6 6" /></svg>;
}
export function ChevronUpIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M6 15l6-6 6 6" /></svg>;
}
export function CloseIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
export function SearchIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
}
export function CopyIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
}
export function TrashIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" /></svg>;
}
export function PauseIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M9 5v14M15 5v14" /></svg>;
}
export function PlayIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p} fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z" /></svg>;
}
export function ReloadIcon({ size = 16, ...p }: IconProps): JSX.Element {
  return <svg {...svgBase(size)} {...p}><path d="M20 11a8 8 0 1 0-.6 4" /><path d="M20 5v6h-6" /></svg>;
}
