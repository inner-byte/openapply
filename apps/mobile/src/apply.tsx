import { Check, KeyRound, Send, Wand2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

interface ApplyStateView {
  application_state: string;
  browser_profile_key: string | null;
  session: {
    state: string;
    origin: string;
    idle_deadline: string;
    warm: boolean;
  } | null;
}

interface PrefillResultView {
  status: "prefilled";
  filled_fields: string[];
  unfilled_fields: string[];
  attached_files: string[];
  stop_reason: string | null;
  questions_for_user: string[];
}

/**
 * Supervised apply (Slice 9). Drives the application from a pack_approved
 * pack through session binding, prefill, explicit submit approval, and the
 * submit waiter. Nothing submits without the user's explicit submit
 * approval — the submit button arms, then confirms, before the waiter runs.
 */
export function ApplySection({ applicationId }: { applicationId: string }) {
  const { api } = useWorkspace();
  const [view, setView] = useState<ApplyStateView | null>(null);
  const [prefill, setPrefill] = useState<PrefillResultView | null>(null);
  const [submitResult, setSubmitResult] = useState<{ clicked: boolean; reason: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [armed, setArmed] = useState<"approve" | "submit" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await api.request<ApplyStateView>(`/api/applications/${applicationId}/apply-state`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, applicationId]);

  useEffect(() => {
    let live = true;
    refresh().catch(() => {});
    return () => {
      live = false;
      void live;
    };
  }, [refresh]);

  async function run<T>(path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError("");
    setArmed(null);
    try {
      const result = await api.request<T>(path, body);
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const state = view?.application_state;
  const warm = view?.session?.warm ?? false;

  return (
    <Card>
      <Text style={s.heading}>Apply</Text>
      <ErrorNotice error={error} />
      {view === null && <Text style={s.muted}>Loading apply state…</Text>}
      {view !== null && (
        <View style={{ gap: 10 }}>
          {state === "pack_approved" && (
            <>
              <Text style={s.muted}>
                Bind this application to a browser session for the job site. You'll sign in yourself
                — the agent never types passwords.
              </Text>
              <Button
                primary
                icon={KeyRound}
                busy={busy}
                onPress={() => void run(`/api/applications/${applicationId}/usher`)}
              >
                Start apply
              </Button>
            </>
          )}
          {state === "session_needed" && (
            <>
              <Text style={s.muted}>
                Sign in on the job site in the browser ({view.session?.origin ?? "the apply site"}),
                then check the session again. Opening it here reuses a saved profile for this site,
                so you stay signed in next time.
              </Text>
              <Button
                primary
                icon={KeyRound}
                busy={busy}
                onPress={async () => {
                  const origin = view.session?.origin;
                  if (!origin) return;
                  await run(`/api/browsers`, {
                    url: origin,
                    profile_key: view.browser_profile_key ?? undefined,
                    session_class: "apply",
                  });
                  await run(`/api/applications/${applicationId}/usher`);
                }}
              >
                Open browser for this site
              </Button>
              <Button
                icon={KeyRound}
                busy={busy}
                onPress={() => void run(`/api/applications/${applicationId}/usher`)}
              >
                Check session
              </Button>
            </>
          )}
          {state === "ready" && warm && (
            <>
              <Text style={s.muted}>
                Browser session is ready. Prefill fills known fields from your confirmed profile and
                attaches the pack files — it never guesses.
              </Text>
              <Button
                primary
                icon={Wand2}
                busy={busy}
                onPress={async () => {
                  const result = await run<PrefillResultView>(
                    `/api/applications/${applicationId}/prefill`,
                  );
                  if (result) setPrefill(result);
                }}
              >
                Prefill application form
              </Button>
            </>
          )}
          {state === "prefilled" && (
            <>
              <Text style={s.muted}>
                Review the prefilled form in the browser. Answer anything it couldn't fill, then
                approve the submit.
              </Text>
              {(prefill?.questions_for_user ?? []).map((q) => (
                <Text key={q} style={s.muted}>
                  • {q}
                </Text>
              ))}
              <Button
                primary={armed === "approve"}
                icon={Check}
                busy={busy}
                onPress={() => {
                  if (armed !== "approve") {
                    setArmed("approve");
                    return;
                  }
                  void run(`/api/applications/${applicationId}/approve-submit`, { confirm: true });
                }}
              >
                {armed === "approve" ? "Tap again to approve submit" : "Approve submit"}
              </Button>
            </>
          )}
          {state === "submit_ready" && (
            <>
              <Text style={s.muted}>
                Submit is approved. The waiter clicks only if the page is still the apply site —
                otherwise it does nothing.
              </Text>
              <Button
                primary={armed === "submit"}
                icon={Send}
                busy={busy}
                onPress={async () => {
                  if (armed !== "submit") {
                    setArmed("submit");
                    return;
                  }
                  const result = await run<{ clicked: boolean; reason: string }>(
                    `/api/applications/${applicationId}/submit`,
                  );
                  if (result) setSubmitResult(result);
                }}
              >
                {armed === "submit" ? "Tap again to submit" : "Submit application"}
              </Button>
              {submitResult && !submitResult.clicked && (
                <Text style={[s.muted, { color: colors.orange }]}>
                  Not submitted: {submitResult.reason}
                </Text>
              )}
            </>
          )}
          {state === "submitted" && (
            <Text style={[s.text, { color: colors.green }]}>
              Submitted. Good luck — replies will land in your inbox.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}
