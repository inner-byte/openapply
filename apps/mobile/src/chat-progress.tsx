/**
 * Slim chat progress indicator (debate slice).
 *
 * A thin status line shown while the agent works — not the heavy tool-card
 * dump. Rules, all enforced here:
 * - State-derived, never narrated: the label comes from the task's status,
 *   title and plan steps via deriveProgress(). Internal role names
 *   (e.g. "hr.review.v2") never surface; keyword rules map to plain words.
 * - No fake percentages: an indeterminate pulse while working, or honest
 *   step counts ("Step 2 of 5") from the task plan. Never a made-up number.
 * - Waiting-on-you is visually distinct and static (no animation), so a
 *   sitting gate never looks like progress.
 * - Failures break the pattern: danger tint, run id + plain-language error.
 * - Every line carries the approval reminder subtly.
 * - "Taking longer than usual" appears when a run shows no activity for 90s.
 * - The full detail (the existing heavy card) stays available, collapsed by
 *   default — tap the line to expand.
 */
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { deriveProgress, LONG_RUNNING_MS, type ProgressInfo } from "./chat-progress-state";
import { colors, s } from "./ui";

function StatusDot({ animate }: { animate: boolean }) {
  const opacity = useRef(new Animated.Value(animate ? 0.35 : 1)).current;
  useEffect(() => {
    if (!animate) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, opacity]);
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.accent,
        opacity,
      }}
    />
  );
}

export function ChatProgressLine({
  task,
  loading,
  error,
  detail,
}: {
  task?: AgentTask;
  loading: boolean;
  /** Tool-result error when no task was resolved. Shown once loading ends. */
  error?: string;
  /** The existing heavy card. Rendered only when expanded. */
  detail: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const info: ProgressInfo =
    !loading && error
      ? {
          kind: "failed",
          label: "Something went wrong",
          error: error.split("\n")[0].trim().slice(0, 200) || "Something went wrong.",
        }
      : deriveProgress(task, loading);
  const active = info.kind === "working" || info.kind === "waiting";

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);

  const lastActivity = task?.updatedAt ? Date.parse(task.updatedAt) : NaN;
  const longRunning = active && !Number.isNaN(lastActivity) && now - lastActivity > LONG_RUNNING_MS;

  const failed = info.kind === "failed";
  const waiting = info.kind === "waiting";
  const Chevron = expanded ? ChevronUp : ChevronDown;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${info.label}. ${expanded ? "Hide" : "Show"} details.`}
        onPress={() => setExpanded((value) => !value)}
        style={[
          s.row,
          {
            gap: 10,
            paddingVertical: 11,
            paddingHorizontal: 14,
            borderRadius: 14,
            backgroundColor: failed ? "#F9E9E8" : waiting ? "#FDF0DF" : "#F1F2F3",
          },
        ]}
      >
        <StatusDot animate={info.kind === "working"} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            style={[s.text, { fontWeight: "600", color: failed ? colors.danger : colors.text }]}
          >
            {info.label}
            {info.stepLabel ? (
              <Text style={{ fontWeight: "400", color: colors.muted }}> · {info.stepLabel}</Text>
            ) : null}
          </Text>
          {failed ? (
            <Text style={s.small}>
              Run {info.runId}
              {info.error ? ` — ${info.error}` : ""}
            </Text>
          ) : (
            <Text style={s.small}>Nothing is sent without your approval.</Text>
          )}
          {longRunning ? (
            <Text style={s.small}>Taking longer than usual — still on it.</Text>
          ) : null}
        </View>
        <Chevron size={16} color={colors.muted} />
      </Pressable>
      {expanded ? <View style={{ marginTop: 8 }}>{detail}</View> : null}
    </View>
  );
}
