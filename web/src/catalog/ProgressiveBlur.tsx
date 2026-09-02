// The fade that dissolves the board under the header. The blur is one painted
// gradient in theme.css; this component survives only so its two mount points
// stay untouched.
export function ProgressiveBlur({ className }: { className?: string }) {
  return <div className={`progressive-blur ${className ?? ''}`} aria-hidden="true" />
}
