interface BrandLogoProps {
  readonly className?: string;
}

export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <img
      aria-hidden="true"
      className={className}
      draggable={false}
      height="64"
      src="/icon.svg"
      width="64"
    />
  );
}
