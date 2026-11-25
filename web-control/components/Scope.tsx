"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ScopeSeries = { name: string; color: string; value: number };

type Props = {
  title: string;
  series: ScopeSeries[];
  /** y-axis range, default -1..1 */
  range?: [number, number];
  /** seconds of history shown, default 8 */
  seconds?: number;
  height?: number;
  /** text drawn over the plot, for example when no controller is connected */
  overlay?: string;
  className?: string;
};

type Sample = { t: number; values: number[] };

function resolveCanvasColor(el: HTMLElement, color: string): string {
  const match = /^var\(\s*(--[^),\s]+)\s*(?:,\s*([^)]+))?\)$/.exec(color.trim());
  if (!match) return color;
  const resolved = getComputedStyle(el).getPropertyValue(match[1]).trim();
  return resolved || match[2]?.trim() || "#fafafa";
}

/**
 * Rolling strip chart on a canvas, appending the current `series` values on every render.
 * Custom on purpose (plan decision 9A): four of these redraw at 60 Hz, which an SVG chart library cannot sustain.
 */
export function Scope({ title, series, range = [-1, 1], seconds = 8, height = 96, overlay, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const history = useRef<Sample[]>([]);
  const colorCache = useRef(new Map<string, string>());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const now = performance.now();
    const samples = history.current;
    samples.push({ t: now, values: series.map(s => s.value) });
    const windowMs = seconds * 1000;
    while (samples.length && samples[0].t < now - windowMs) samples.shift();

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [lo, hi] = range;
    const y = (v: number) => height - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * height;
    const x = (t: number) => width - ((now - t) / windowMs) * width;

    ctx.strokeStyle = "#27272a"; ctx.lineWidth = 1;
    for (const level of [lo, (lo + hi) / 2, hi]) { ctx.beginPath(); ctx.moveTo(0, Math.round(y(level)) + 0.5); ctx.lineTo(width, Math.round(y(level)) + 0.5); ctx.stroke(); }

    series.forEach((s, i) => {
      let stroke = colorCache.current.get(s.color);
      if (!stroke) { stroke = resolveCanvasColor(canvas, s.color); colorCache.current.set(s.color, stroke); }
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.beginPath();
      samples.forEach((sample, k) => { const px = x(sample.t), py = y(sample.values[i] ?? 0); if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
    });
  });

  return <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{title}</span>
      <span className="tabular flex shrink-0 gap-3 font-mono text-[11px] font-semibold">
        {series.map(s => <span key={s.name} style={{ color: s.color }}>{s.name} {s.value >= 0 ? "+" : ""}{s.value.toFixed(2)}</span>)}
      </span>
    </div>
    <div className="relative">
      <canvas ref={canvasRef} className="block w-full rounded-md bg-[#0b0b0d]" style={{ height }} aria-label={`${title} graph`} role="img" />
      {overlay && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{overlay}</div>}
    </div>
  </div>;
}
