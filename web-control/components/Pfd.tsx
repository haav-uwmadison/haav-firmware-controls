"use client";

// Primary flight display for the boat, drawn as one SVG: speed tape (left), attitude ball with pitch
// ladder and bank scale (centre), turn-rate tape (right), compass arc (bottom) and the mode/arm/GPS
// annunciators across the top. Pure view: every number comes from MissionState.pfd and telemetry.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toneBadge } from "@/components/StatusBar";
import type { Pfd, Telemetry } from "@/lib/mission-controller";
import { cn } from "@/lib/utils";

type Props = { pfd: Pfd; telemetry: Telemetry; connected: boolean; className?: string };

// Geometry (SVG user units). The drawing scales to the card with preserveAspectRatio.
const W = 480, H = 404;
const AX = 92, AY = 36, AW = 296, AH = 296;        // attitude window
const CX = AX + AW / 2, CY = AY + AH / 2;
const PX_PER_DEG = 6;                              // pitch ladder scale
const TAPE_Y = AY, TAPE_H = AH;
const SPEED_X = 12, SPEED_W = 62, PX_PER_KN = 26;  // speed tape
const TURN_X = 406, TURN_W = 62, TURN_MAX = 30;    // turn-rate tape, ±deg/s
const HDG_R = 210, HDG_TOP = AY + AH + 16, HDG_CY = HDG_TOP + HDG_R; // compass arc

const colors = {
  sky: "#2f86d6", water: "#0d3556", tape: "#3a3a3f", text: "#ffffff", dim: "#9a9aa3",
  magenta: "#f06cff", green: "#5cff78", amber: "#ffcc4d", red: "#ff5c5c",
};

const MPS_TO_KN = 1.94384;
const fmt = (v: number | null, digits = 0) => v === null ? "---" : v.toFixed(digits);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cardinal: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };

export function PfdPanel({ pfd, telemetry, connected, className }: Props) {
  const hasAttitude = pfd.rollDeg !== null && pfd.pitchDeg !== null;
  const badge = !connected ? { tone: "idle" as const, text: "No link" } : hasAttitude ? { tone: "ok" as const, text: "Attitude live" } : { tone: "warn" as const, text: "Waiting for ATTITUDE" };
  return <Card className={cn("flex min-h-0 flex-col gap-0 py-0", className)}>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Primary display</CardTitle>
      <div className="flex items-center gap-2">
        <span className="tabular hidden font-mono text-[11px] text-muted-foreground xl:inline">
          roll {fmt(pfd.rollDeg)}° · pitch {fmt(pfd.pitchDeg)}° · {fmt(pfd.yawRateDps)}°/s
        </span>
        <Badge className={cn("text-[11px] font-bold tracking-[0.04em]", toneBadge[badge.tone])} role="status">{badge.text}</Badge>
      </div>
    </CardHeader>
    <CardContent className="relative min-h-0 flex-1 bg-black p-2">
      <PfdSvg pfd={pfd} telemetry={telemetry} />
      {!hasAttitude && <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-3 text-sm text-muted-foreground">{connected ? "Waiting for attitude from the Pixhawk" : "No attitude yet. Connect to the Pixhawk."}</div>}
    </CardContent>
  </Card>;
}

function PfdSvg({ pfd, telemetry }: { pfd: Pfd; telemetry: Telemetry }) {
  const roll = pfd.rollDeg ?? 0, pitch = pfd.pitchDeg ?? 0;
  const speedKn = pfd.speedMps === null ? null : pfd.speedMps * MPS_TO_KN;
  const heading = pfd.headingDeg;
  const turn = pfd.yawRateDps;
  const armed = telemetry.armed;
  return <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full font-mono select-none" aria-label="Primary flight display" role="img">
    <defs>
      <clipPath id="pfd-att"><rect x={AX} y={AY} width={AW} height={AH} rx={18} /></clipPath>
      <clipPath id="pfd-speed"><rect x={SPEED_X} y={TAPE_Y} width={SPEED_W + 8} height={TAPE_H} /></clipPath>
      <clipPath id="pfd-hdg"><rect x={AX - 30} y={HDG_TOP} width={AW + 60} height={H - HDG_TOP} /></clipPath>
    </defs>

    {/* annunciators */}
    <Annunciator x={AX} w={AW / 3} text={telemetry.mode} color={colors.green} />
    <Annunciator x={AX + AW / 3} w={AW / 3} text={armed === null ? "---" : armed ? "ARMED" : "DISARMED"} color={armed ? colors.red : armed === null ? colors.dim : colors.green} />
    <Annunciator x={AX + (2 * AW) / 3} w={AW / 3} text={telemetry.gps === "—" ? "NO GPS" : telemetry.gps.replace(" sats", "").replace("No 3D fix", "NO 3D").toUpperCase()} color={telemetry.gps.startsWith("Fix") ? colors.green : colors.amber} />

    <Attitude roll={roll} pitch={pitch} />
    <SpeedTape kn={speedKn} />
    <TurnTape dps={turn} />
    <CompassArc heading={heading} />
  </svg>;
}

function Annunciator({ x, w, text, color }: { x: number; w: number; text: string; color: string }) {
  return <g>
    <line x1={x + w} y1={6} x2={x + w} y2={28} stroke={colors.dim} strokeWidth={1} opacity={0.6} />
    <text x={x + w / 2} y={22} textAnchor="middle" fill={color} fontSize={15} fontWeight={700}>{text}</text>
  </g>;
}

function Attitude({ roll, pitch }: { roll: number; pitch: number }) {
  const ladder: number[] = [];
  for (let deg = -60; deg <= 60; deg += 5) if (deg !== 0) ladder.push(deg);
  const bankTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
  const bankR = AH / 2 - 10;
  return <g>
    <g clipPath="url(#pfd-att)">
      {/* The horizon rolls and pitches behind the fixed boat symbol: right roll tilts it anticlockwise,
          nose-up pushes it down. */}
      <g transform={`rotate(${-roll} ${CX} ${CY})`}>
        <g transform={`translate(0 ${pitch * PX_PER_DEG})`}>
          <rect x={CX - 1200} y={CY - 2400} width={2400} height={2400} fill={colors.sky} />
          <rect x={CX - 1200} y={CY} width={2400} height={2400} fill={colors.water} />
          <line x1={CX - 1200} y1={CY} x2={CX + 1200} y2={CY} stroke={colors.text} strokeWidth={2} />
          {ladder.map(deg => {
            const y = CY - deg * PX_PER_DEG, major = deg % 10 === 0, half = major ? 34 : 16;
            return <g key={deg}>
              <line x1={CX - half} y1={y} x2={CX + half} y2={y} stroke={colors.text} strokeWidth={major ? 2 : 1.5} />
              {major && <>
                <text x={CX - half - 8} y={y + 5} textAnchor="end" fill={colors.text} fontSize={13}>{Math.abs(deg)}</text>
                <text x={CX + half + 8} y={y + 5} textAnchor="start" fill={colors.text} fontSize={13}>{Math.abs(deg)}</text>
              </>}
            </g>;
          })}
        </g>
        {/* bank pointer rides with the horizon */}
        <polygon points={`${CX},${CY - bankR + 2} ${CX - 8},${CY - bankR + 16} ${CX + 8},${CY - bankR + 16}`} fill={colors.text} />
      </g>
      {/* fixed bank scale */}
      {bankTicks.map(deg => {
        const a = (deg * Math.PI) / 180, len = deg === 0 ? 0 : Math.abs(deg) % 30 === 0 || Math.abs(deg) === 45 ? 14 : 8;
        const x1 = CX + Math.sin(a) * bankR, y1 = CY - Math.cos(a) * bankR;
        const x2 = CX + Math.sin(a) * (bankR + len), y2 = CY - Math.cos(a) * (bankR + len);
        return deg === 0
          ? <polygon key={deg} points={`${CX},${CY - bankR} ${CX - 9},${CY - bankR - 16} ${CX + 9},${CY - bankR - 16}`} fill={colors.text} />
          : <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.text} strokeWidth={2} />;
      })}
      {/* fixed boat symbol */}
      <g fill="#000" stroke={colors.text} strokeWidth={2}>
        <path d={`M${CX - 110},${CY - 4} h66 v12 h-10 v-4 h-56 z`} />
        <path d={`M${CX + 110},${CY - 4} h-66 v12 h10 v-4 h56 z`} />
        <rect x={CX - 5} y={CY - 5} width={10} height={10} />
      </g>
    </g>
    <rect x={AX} y={AY} width={AW} height={AH} rx={18} fill="none" stroke="#1f1f24" strokeWidth={2} />
  </g>;
}

function SpeedTape({ kn }: { kn: number | null }) {
  const v = kn ?? 0, mid = TAPE_Y + TAPE_H / 2;
  const ticks: number[] = [];
  for (let k = Math.max(0, Math.floor(v - 6)); k <= v + 6; k += 1) ticks.push(k);
  return <g>
    <rect x={SPEED_X} y={TAPE_Y} width={SPEED_W} height={TAPE_H} fill={colors.tape} />
    <g clipPath="url(#pfd-speed)">
      {ticks.map(k => {
        const y = mid + (v - k) * PX_PER_KN;
        return <g key={k}>
          <line x1={SPEED_X + SPEED_W - 10} y1={y} x2={SPEED_X + SPEED_W} y2={y} stroke={colors.text} strokeWidth={2} />
          {k % 2 === 0 && <text x={SPEED_X + SPEED_W - 16} y={y + 5} textAnchor="end" fill={colors.text} fontSize={15}>{k}</text>}
        </g>;
      })}
    </g>
    {/* current value box with pointer */}
    <path d={`M${SPEED_X - 2},${mid - 18} h${SPEED_W} l10,18 l-10,18 h-${SPEED_W} z`} fill="#000" stroke={colors.text} strokeWidth={2} />
    <text x={SPEED_X + SPEED_W - 10} y={mid + 7} textAnchor="end" fill={colors.text} fontSize={20} fontWeight={700}>{fmt(kn, 1)}</text>
    <text x={SPEED_X + 2} y={TAPE_Y - 10} fill={colors.magenta} fontSize={13} fontWeight={700}>KN</text>
    <text x={SPEED_X + 2} y={TAPE_Y + TAPE_H + 20} fill={colors.green} fontSize={13} fontWeight={700}>GS {kn === null ? "---" : (kn / MPS_TO_KN).toFixed(1)} m/s</text>
  </g>;
}

function TurnTape({ dps }: { dps: number | null }) {
  const mid = TAPE_Y + TAPE_H / 2, pxPer = (TAPE_H / 2 - 14) / TURN_MAX;
  const v = clamp(dps ?? 0, -TURN_MAX, TURN_MAX);
  const marks = [-30, -20, -10, 0, 10, 20, 30];
  return <g>
    <rect x={TURN_X} y={TAPE_Y} width={TURN_W} height={TAPE_H} fill={colors.tape} />
    {marks.map(m => {
      const y = mid - m * pxPer;
      return <g key={m}>
        <line x1={TURN_X} y1={y} x2={TURN_X + (m % 20 === 0 ? 12 : 7)} y2={y} stroke={colors.text} strokeWidth={2} />
        {m !== 0 && <text x={TURN_X + 18} y={y + 5} fill={colors.text} fontSize={13}>{Math.abs(m)}</text>}
      </g>;
    })}
    <line x1={TURN_X} y1={mid} x2={TURN_X + TURN_W} y2={mid} stroke={colors.dim} strokeWidth={1} />
    {/* needle: positive (right/starboard turn) rises above centre, negative (left/port turn) drops below */}
    <polygon points={`${TURN_X + TURN_W},${mid - v * pxPer} ${TURN_X + TURN_W - 16},${mid - v * pxPer - 7} ${TURN_X + TURN_W - 16},${mid - v * pxPer + 7}`} fill={colors.magenta} />
    <text x={TURN_X + TURN_W - 2} y={TAPE_Y - 10} textAnchor="end" fill={colors.magenta} fontSize={13} fontWeight={700}>TURN °/s</text>
    <text x={TURN_X + TURN_W - 2} y={TAPE_Y + TAPE_H + 20} textAnchor="end" fill={colors.green} fontSize={13} fontWeight={700}>{dps === null ? "---" : `${dps > 0 ? "R" : dps < 0 ? "L" : ""} ${Math.abs(dps).toFixed(1)}`}</text>
  </g>;
}

function CompassArc({ heading }: { heading: number | null }) {
  const h = heading ?? 0;
  const ticks: { deg: number; delta: number }[] = [];
  for (let d = -45; d <= 45; d += 5) {
    const deg = ((Math.round(h / 5) * 5 + d) % 360 + 360) % 360;
    ticks.push({ deg, delta: deg - h });
  }
  const pt = (delta: number, r: number) => {
    const a = (normalize(delta) * Math.PI) / 180;
    return [CX + Math.sin(a) * r, HDG_CY - Math.cos(a) * r] as const;
  };
  return <g>
    <g clipPath="url(#pfd-hdg)">
      <circle cx={CX} cy={HDG_CY} r={HDG_R} fill={colors.tape} />
      {ticks.map(({ deg, delta }) => {
        const major = deg % 10 === 0, [x1, y1] = pt(delta, HDG_R), [x2, y2] = pt(delta, HDG_R - (major ? 12 : 7));
        const [tx, ty] = pt(delta, HDG_R - 26);
        const label = cardinal[deg] ?? String(deg / 10);
        return <g key={deg}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.text} strokeWidth={major ? 2 : 1.5} />
          {major && <text x={tx} y={ty + 5} textAnchor="middle" fill={cardinal[deg] ? colors.green : colors.text} fontSize={cardinal[deg] ? 15 : 13} fontWeight={cardinal[deg] ? 700 : 400} transform={`rotate(${normalize(delta)} ${tx} ${ty})`}>{label}</text>}
        </g>;
      })}
      <line x1={CX} y1={HDG_TOP} x2={CX} y2={HDG_CY - HDG_R + 60} stroke={colors.text} strokeWidth={2} />
    </g>
    <polygon points={`${CX},${HDG_TOP + 2} ${CX - 8},${HDG_TOP - 12} ${CX + 8},${HDG_TOP - 12}`} fill={colors.text} />
    <text x={CX - 14} y={HDG_TOP - 3} textAnchor="end" fill={colors.magenta} fontSize={15} fontWeight={700}>{heading === null ? "---" : `${Math.round(h) % 360}`.padStart(3, "0")} H</text>
    <text x={CX + 14} y={HDG_TOP - 3} textAnchor="start" fill={colors.green} fontSize={12} fontWeight={700}>MAG</text>
  </g>;
}

const normalize = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;
