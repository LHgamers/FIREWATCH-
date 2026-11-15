export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden>
      <defs>
        <linearGradient id="fw-ring" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#39C8F2" />
          <stop offset="1" stopColor="#39C8F2" stopOpacity="0.25" />
        </linearGradient>
        <radialGradient id="fw-core" cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#FFB067" />
          <stop offset="1" stopColor="#FF633D" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="15.5" stroke="url(#fw-ring)" strokeWidth="1.1" />
      <ellipse cx="20" cy="20" rx="15.5" ry="6.4" stroke="#39C8F2" strokeOpacity="0.35" strokeWidth="0.9" transform="rotate(-28 20 20)" />
      <path d="M20 12.5c3.2 3.1 5 6.2 5 9.1a5 5 0 1 1-10 0c0-2.9 1.8-6 5-9.1Z" fill="url(#fw-core)" />
      <path d="M20 20.5c1.5 1.6 2.2 2.9 2.2 4a2.2 2.2 0 1 1-4.4 0c0-1.1.7-2.4 2.2-4Z" fill="#0B1220" fillOpacity="0.55" />
      <circle cx="31.4" cy="12.2" r="2.1" fill="#39C8F2" />
      <circle cx="31.4" cy="12.2" r="3.6" stroke="#39C8F2" strokeOpacity="0.35" strokeWidth="0.8" />
    </svg>
  );
}
