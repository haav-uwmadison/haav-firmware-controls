import { cn } from "@/lib/utils";

type Props = {
  label: string;
  /** current value in the same units as min/max (PWM microseconds) */
  value: number;
  min?: number;
  max?: number;
  center?: number;
  color?: string;
  unit?: string;
  leftLabel?: string;
  rightLabel?: string;
  /** symmetric limit around the centre, in the same units; the region beyond it is shaded */
  limit?: number;
  className?: string;
};

/**
 * Centre-zero bar from min to max, filling away from the centre.
 * Custom on purpose (plan decision 9A): shadcn Progress only fills from one end.
 */
export function BipolarGauge({ label, value, min = 1000, max = 2000, center = 1500, color = "var(--live)", unit = "µs", leftLabel, rightLabel, limit, className }: Props) {
  const clamped = Math.min(max, Math.max(min, value));
  const centerPct = ((center - min) / (max - min)) * 100;
  const valuePct = ((clamped - min) / (max - min)) * 100;
  const left = Math.min(centerPct, valuePct);
  const width = Math.abs(valuePct - centerPct);
  const limitPct = limit === undefined ? null : (limit / (max - min)) * 100;
  return <div className={cn("flex min-w-0 flex-col", className)}>
    <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
    <div className="tabular mt-1 mb-3 font-mono text-4xl font-bold leading-none">
      {Math.round(value)} <span className="text-sm font-medium text-muted-foreground">{unit}</span>
    </div>
    <div className="relative h-2.5 rounded-full bg-zinc-800" role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-label={label}>
      {limitPct !== null && <>
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-[repeating-linear-gradient(135deg,transparent_0_3px,#3f3f46_3px_4px)]" style={{ width: `${Math.max(0, centerPct - limitPct)}%` }} aria-hidden />
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-[repeating-linear-gradient(135deg,transparent_0_3px,#3f3f46_3px_4px)]" style={{ width: `${Math.max(0, 100 - centerPct - limitPct)}%` }} aria-hidden />
      </>}
      <div className="absolute -top-1 h-[18px] w-px bg-zinc-500" style={{ left: `${centerPct}%` }} />
      <div className="absolute top-0 h-2.5 rounded-full" style={{ left: `${left}%`, width: `${width}%`, background: color }} />
    </div>
    <div className="tabular mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
      <span>{leftLabel ?? min}</span><span>{center}</span><span>{rightLabel ?? max}</span>
    </div>
  </div>;
}
