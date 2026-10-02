/**
 * OpenApply navigation icons.
 *
 * Academic-resonating, function-specific marks that replace the stock Lucide
 * glyphs in the bottom nav. Each one pairs a scholarly motif with what the
 * page does:
 * - Chat: a graduation cap speaking — wise counsel.
 * - Jobs: a diploma scroll under seal — proclamations of opportunity.
 * - Applications: your papers, sealed with a check — the dossier.
 * - Activity: an open journal with a bookmark — your record.
 * - Apps: a bookshelf — your library of capabilities.
 *
 * Stroke-based, 24x24, currentColor — the same prop contract as Lucide
 * (`size`, `strokeWidth`, `color`) so they drop into the nav untouched.
 */
import type { ReactNode } from "react";
import Svg, { Circle, Path } from "react-native-svg";

export interface NavIconProps {
  size?: number;
  strokeWidth?: number;
  color?: string;
}

function Base({
  size = 24,
  strokeWidth = 2,
  color = "currentColor",
  children,
}: NavIconProps & { children: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

/** Chat — a graduation cap speaking: wise counsel. */
export function ChatIcon(props: NavIconProps) {
  return (
    <Base {...props}>
      {/* speech bubble */}
      <Path d="M4 4h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      {/* mortarboard board */}
      <Path d="M12 6.8l5.5 2.2-5.5 2.2-5.5-2.2L12 6.8z" />
      {/* head band */}
      <Path d="M9.2 9.7v1.5c0 1.1 1.2 2 2.8 2s2.8-.9 2.8-2V9.7" />
    </Base>
  );
}

/** Jobs — a diploma scroll under seal: proclamations of opportunity. */
export function JobsIcon(props: NavIconProps) {
  return (
    <Base {...props}>
      {/* paper */}
      <Path d="M7 3.5h10V20H7z" />
      {/* top roll */}
      <Path d="M7 3.5C5 3.5 4 4.6 4 6v11c0 1.4 1 2.5 3 2.5" />
      {/* tie line */}
      <Path d="M7 8h10" />
      {/* seal */}
      <Circle cx="12" cy="14" r="2.6" />
      <Path d="M10.9 16.2l-1 3.3 2.1-1.2 2.1 1.2-1-3.3" />
    </Base>
  );
}

/** Applications — your papers, sealed with a check: the dossier. */
export function ApplicationsIcon(props: NavIconProps) {
  return (
    <Base {...props}>
      {/* document */}
      <Path d="M6 2.5h8l5 5v14H6z" />
      {/* fold */}
      <Path d="M14 2.5v5h5" />
      {/* wax seal with check */}
      <Circle cx="12" cy="15" r="3" />
      <Path d="M10.4 15l1.2 1.2 2-2.4" />
    </Base>
  );
}

/** Activity — an open journal with a bookmark: your record. */
export function ActivityIcon(props: NavIconProps) {
  return (
    <Base {...props}>
      {/* open book */}
      <Path d="M12 6.5C10 5.2 7 5 4 5v13.5c3 0 6 .2 8 1.5 2-1.3 5-1.5 8-1.5V5c-3 0-6 .2-8 1.5z" />
      {/* spine */}
      <Path d="M12 6.5V20" />
      {/* bookmark */}
      <Path d="M16.5 8v4.5l-1.4-1-1.4 1V8" />
    </Base>
  );
}

/** Apps — a bookshelf: your library of capabilities. */
export function AppsIcon(props: NavIconProps) {
  return (
    <Base {...props}>
      {/* shelf frame */}
      <Path d="M4 4h16M4 20h16M6 4v16M18 4v16" />
      {/* books, one leaning on the upright */}
      <Path d="M9.5 20v-7M12.5 20V9M14.6 20l1.7-4.4" />
    </Base>
  );
}
