// Dot-matrix graphics: dashed strokes with round caps render as rows of dots.

const TENTACLES_4 =
  "M52 119C48 140 22 150 20 172S30 202 14 212M80 139C79 154 66 160 66 172S72 200 64 212M120 139C121 154 134 160 134 172S128 200 136 212M148 119C152 140 178 150 180 172S170 202 186 212";
const TENTACLES_8 =
  "M52 119C48 140 22 150 20 172S30 202 14 212M66 132C63 150 44 156 42 172S50 200 38 212M80 139C79 154 66 160 66 172S72 200 64 212M93 142C93 156 88 162 88 172S92 200 88 212M107 142C107 156 112 162 112 172S108 200 112 212M120 139C121 154 134 160 134 172S128 200 136 212M134 132C137 150 156 156 158 172S150 200 162 212M148 119C152 140 178 150 180 172S170 202 186 212";

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 200 220" width={size} height={size * 1.1} fill="none" stroke="var(--ink)" strokeWidth="13" strokeLinecap="round" strokeDasharray="0 22" aria-hidden="true">
      <circle cx="100" cy="80" r="62" />
      <ellipse cx="100" cy="80" rx="28" ry="62" />
      <path d={TENTACLES_4} />
      <circle cx="187" cy="63" r="14" fill="var(--accent)" stroke="none" />
    </svg>
  );
}

export function Emblem({ size = 220 }: { size?: number }) {
  return (
    <svg viewBox="-12 -16 224 240" width={size} height={size * 1.07} fill="none" strokeLinecap="round" aria-hidden="true">
      <g stroke="var(--ink)" strokeWidth="3.6" strokeDasharray="0 7.5">
        <circle cx="100" cy="80" r="62" />
        <ellipse cx="100" cy="80" rx="40" ry="62" />
        <ellipse cx="100" cy="80" rx="14" ry="62" />
        <ellipse cx="100" cy="80" rx="62" ry="11" />
        <ellipse cx="100" cy="52" rx="55" ry="8" />
        <ellipse cx="100" cy="108" rx="55" ry="8" />
        <path d={TENTACLES_8} />
      </g>
      <circle className="eye" cx="86" cy="76" r="4.5" fill="var(--accent)" />
      <circle className="eye" cx="114" cy="76" r="4.5" fill="var(--accent)" />
      <g className="orbit">
        <ellipse cx="100" cy="80" rx="96" ry="22" transform="rotate(-16 100 80)" stroke="var(--accent)" strokeWidth="3" strokeDasharray="0 9" />
        <circle cx="189" cy="62" r="5" fill="var(--accent)" />
      </g>
    </svg>
  );
}

export function Face({ mood }: { mood: "idle" | "busy" | "waiting" | "off" }) {
  const eyes = mood === "off" ? "var(--dim)" : "var(--accent)";
  const mouth = mood === "waiting" ? "M110 62q12 6 24 0" : mood === "busy" ? "M112 60h20" : "M112 60q10 4 20 0";
  return (
    <svg viewBox="0 0 240 110" width="100%" height="104" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="120" cy="48" r="36" stroke="var(--ink)" strokeWidth="3.2" strokeDasharray="0 7.5" />
      <circle className={mood === "off" ? "" : "eye"} cx="110" cy="46" r="3.6" fill={eyes} />
      <circle className={mood === "off" ? "" : "eye"} cx="134" cy="46" r="3.6" fill={eyes} />
      <path d={mouth} stroke="var(--ink)" strokeWidth="2.6" strokeDasharray="0 5" />
      <path d="M4 102H86l5-8 5 14 5-20 5 26 5-18 5 10 5-6H236" stroke="var(--dim)" strokeWidth="2.4" strokeDasharray="0 5" />
      {mood === "busy" && <path d="M96 108l5-20 5 26 5-18" stroke="var(--accent)" strokeWidth="2.4" strokeDasharray="0 4" />}
    </svg>
  );
}

export function DotRing({ percent, size = 104 }: { percent: number; size?: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const angle = (p / 100) * 2 * Math.PI;
  const x = 60 + 48 * Math.sin(angle);
  const y = 60 - 48 * Math.cos(angle);
  const large = p > 50 ? 1 : 0;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="60" cy="60" r="48" stroke="var(--dot)" strokeWidth="4" strokeDasharray="0 8" />
      {p >= 99.5 ? (
        <circle cx="60" cy="60" r="48" stroke="var(--accent)" strokeWidth="4" strokeDasharray="0 8" />
      ) : p > 0 ? (
        <path d={`M60 12A48 48 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}`} stroke="var(--accent)" strokeWidth="4" strokeDasharray="0 8" />
      ) : null}
    </svg>
  );
}

export function DotSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3.6" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
    </svg>
  );
}

type IconName = "plus" | "folder" | "key" | "bug" | "send" | "stop" | "check" | "chevron-right" | "chevron-down" | "close" | "refresh";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "plus": return <svg {...common}><path d="M8 2.5v11M2.5 8h11" /></svg>;
    case "folder": return <svg {...common}><path d="M1.5 4.5h5l1.5 2h6.5v6.5h-13z" /></svg>;
    case "key": return <svg {...common}><circle cx="5" cy="10" r="3" /><path d="M7.2 7.8L13.5 1.5M11 4l2 2" /></svg>;
    case "bug": return <svg {...common}><path d="M2 4h12M2 8h8M2 12h10" /></svg>;
    case "send": return <svg {...common} strokeWidth={1.8}><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>;
    case "stop": return <svg {...common}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
    case "check": return <svg {...common}><path d="M3 8.5l3 3 7-7" /></svg>;
    case "chevron-right": return <svg {...common}><path d="M6 3.5l4.5 4.5L6 12.5" /></svg>;
    case "chevron-down": return <svg {...common}><path d="M3.5 6l4.5 4.5L12.5 6" /></svg>;
    case "close": return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
    case "refresh": return <svg {...common}><path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5" /></svg>;
  }
}
