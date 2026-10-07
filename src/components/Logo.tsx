import { useId } from 'react'

export function Logo({ size = 24 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8bff" />
          <stop offset="0.55" stopColor="#9b5cff" />
          <stop offset="1" stopColor="#ff6b8b" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}g)`} />
      <rect width="512" height="512" rx="116" fill={`url(#${id}s)`} />
      <circle cx="344" cy="168" r="46" fill="#fff" />
      <path
        d="M100 396 L214 238 L328 396 Z M268 396 L346 290 L424 396 Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="28"
        strokeLinejoin="round"
      />
    </svg>
  )
}
