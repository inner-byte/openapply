/**
 * OpenApply avatar marks.
 *
 * Eight abstract, OpenApply-owned SVG marks — geometric, professional, and
 * deliberately never a fake human face. The default `open-ring` mark is the
 * original OpenApply motif (open ring + arrow breaking out: applications
 * going out into the world).
 *
 * Self-contained (no ui.tsx import) so ui.tsx can import AvatarMark without
 * a module cycle.
 */
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Ellipse, Path, Polygon, Rect } from "react-native-svg";

const INK = "#FFFFFF";
const SQUIRCLE = "#2563EB";

export interface AvatarDef {
  id: string;
  name: string;
  render: (size: number) => ReactNode;
}

function Shell({ size, children }: { size: number; children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x="2" y="2" width="60" height="60" rx="18" fill={SQUIRCLE} />
      {children}
    </Svg>
  );
}

const STROKE = {
  fill: "none",
  stroke: INK,
  strokeWidth: 5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const AVATARS: AvatarDef[] = [
  {
    id: "open-ring",
    name: "Open Ring",
    render: (size) => (
      <Shell size={size}>
        <Circle cx="26" cy="38" r="12.5" fill="none" stroke={INK} strokeWidth="5" />
        <Path d="M26 38 L44 20" {...STROKE} />
        <Path d="M34.5 20 L44 20 L44 29.5" {...STROKE} />
      </Shell>
    ),
  },
  {
    id: "ascent",
    name: "Ascent",
    render: (size) => (
      <Shell size={size}>
        <Path d="M18 42 L32 28 L46 42" {...STROKE} />
        <Path d="M18 28 L32 14 L46 28" {...STROKE} />
      </Shell>
    ),
  },
  {
    id: "layers",
    name: "Layers",
    render: (size) => (
      <Shell size={size}>
        <Polygon
          points="32,12 50,21 32,30 14,21"
          fill="none"
          stroke={INK}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <Polygon
          points="32,26 50,35 32,44 14,35"
          fill="none"
          stroke={INK}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <Polygon
          points="32,40 50,49 32,58 14,49"
          fill="none"
          stroke={INK}
          strokeWidth="4"
          strokeLinejoin="round"
        />
      </Shell>
    ),
  },
  {
    id: "compass",
    name: "Compass",
    render: (size) => (
      <Shell size={size}>
        <Circle cx="32" cy="32" r="19" fill="none" stroke={INK} strokeWidth="4" />
        <Polygon
          points="32,14 36.5,27.5 50,32 36.5,36.5 32,50 27.5,36.5 14,32 27.5,27.5"
          fill={INK}
        />
      </Shell>
    ),
  },
  {
    id: "pulse",
    name: "Pulse",
    render: (size) => (
      <Shell size={size}>
        <Path d="M10 32 L21 32 L27 16 L35 48 L41 24 L45 32 L54 32" {...STROKE} />
      </Shell>
    ),
  },
  {
    id: "grid",
    name: "Grid",
    render: (size) => (
      <Shell size={size}>
        <Path
          d="M20 20 L32 32 L44 20 M20 44 L32 32 L44 44 M20 20 L20 44 M44 20 L44 44"
          fill="none"
          stroke={INK}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {[
          [20, 20],
          [44, 20],
          [32, 32],
          [20, 44],
          [44, 44],
        ].map(([cx, cy]) => (
          <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4.5" fill={INK} />
        ))}
      </Shell>
    ),
  },
  {
    id: "orbit",
    name: "Orbit",
    render: (size) => (
      <Shell size={size}>
        <Ellipse
          cx="32"
          cy="34"
          rx="21"
          ry="12"
          fill="none"
          stroke={INK}
          strokeWidth="4"
          transform="rotate(-18 32 34)"
        />
        <Circle cx="32" cy="34" r="7" fill={INK} />
        <Circle cx="50" cy="22" r="4.5" fill={INK} />
      </Shell>
    ),
  },
  {
    id: "summit",
    name: "Summit",
    render: (size) => (
      <Shell size={size}>
        <Path d="M10 46 L26 22 L34 34 L41 24 L54 46" {...STROKE} />
        <Circle cx="45" cy="15" r="3.5" fill={INK} />
      </Shell>
    ),
  },
];

const byId = new Map(AVATARS.map((a) => [a.id, a]));

/** Legacy agent-identity values from before the avatar set existed. */
const LEGACY_IDS = new Set(["sky", "sand", "lilac"]);

export function isLegacyAvatarId(id: string): boolean {
  return LEGACY_IDS.has(id);
}

export function avatarDef(id?: string): AvatarDef {
  return (id && byId.get(id)) || AVATARS[0];
}

export function AvatarMark({ id, size = 42 }: { id?: string; size?: number }) {
  const def = avatarDef(id);
  return (
    <View accessibilityLabel={`${def.name} avatar`} style={{ width: size, height: size }}>
      {def.render(size)}
    </View>
  );
}

export function AvatarPicker({
  value,
  onSelect,
}: {
  value?: string;
  onSelect: (id: string) => void;
}) {
  const selected = avatarDef(value).id;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {AVATARS.map((a) => {
        const active = selected === a.id;
        return (
          <Pressable
            key={a.id}
            accessibilityRole="radio"
            accessibilityLabel={`${a.name} avatar`}
            accessibilityState={{ checked: active }}
            onPress={() => onSelect(a.id)}
            style={{
              padding: 6,
              borderRadius: 20,
              borderWidth: 2,
              borderColor: active ? SQUIRCLE : "transparent",
              backgroundColor: active ? "#EDF7FD" : "transparent",
            }}
          >
            <AvatarMark id={a.id} size={52} />
          </Pressable>
        );
      })}
    </View>
  );
}
