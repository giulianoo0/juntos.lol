// The fade that dissolves the board under the header. It used to be five
// stacked backdrop-filter layers — a real progressive blur, and an expensive
// one: five backdrop roots across the full window width, redone on every video
// frame that played behind them. It is one painted gradient now (theme.css),
// and the component survives only so its two mount points stay untouched.
export function ProgressiveBlur({ className }: { className?: string }) {
  return <div className={`progressive-blur ${className ?? ''}`} aria-hidden="true" />
}
