/**
 * CV interview builder (client): a chat-like interview for users without a CV.
 * The server asks from a deterministic question bank; every answer is stored
 * verbatim as a quoted triple. Nothing here elaborates or polishes.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, colors, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type SectionId = "basics" | "work_history" | "skills" | "education";
type SectionState = "draft" | "correction" | "re-draft" | "locked";

interface Question {
  id: string;
  section: SectionId;
  field: string;
  prompt: string;
  why: string;
  required: boolean;
}

interface Conflict {
  id: string;
  field: string;
  question_id: string;
  existing: string;
  incoming: string;
  resolved: boolean;
}

interface Answer {
  field: string;
  question_id: string;
  triple: { quoted_statement: string; confirmed: boolean; asked_at: string };
  quarantined: boolean;
}

interface ResumePreview {
  full_name: string;
  email: string;
  mobile: string;
  education: Array<{ institution: string; degree: string; dates: string }>;
  skills: Array<{ category: string; items: string }>;
  experience: Array<{ title: string; dates: string; bullets: string[] }>;
}

interface InterviewView {
  interview: {
    id: string;
    status: "in_progress" | "ready_for_signoff" | "signed_off";
    answers: Record<string, Answer>;
    signed_off_at?: string;
  } | null;
  questions: Question[];
  current: Question | null;
  completeness: number;
  required_answered: number;
  required_total: number;
  section_states: Record<SectionId, SectionState> | null;
  open_conflicts: Conflict[];
  blocked_on: string[];
  draft_preview: ResumePreview | null;
  has_master_draft: boolean;
}

const SECTION_LABELS: Record<SectionId, string> = {
  basics: "Basics",
  work_history: "Work",
  skills: "Skills",
  education: "Education",
};

function sectionTint(state: SectionState): string {
  switch (state) {
    case "locked":
      return colors.green;
    case "correction":
      return colors.danger;
    case "re-draft":
      return colors.orange;
    default:
      return colors.canvas;
  }
}

function DraftPreview({ preview, signedOff }: { preview: ResumePreview; signedOff: boolean }) {
  return (
    <Card style={{ gap: 8 }}>
      <View style={[s.row, { gap: 8 }]}>
        <Text style={s.heading}>Draft preview</Text>
        <Chip tint={signedOff ? colors.green : colors.orange}>
          {signedOff ? "SIGNED OFF" : "THIN — UNVERIFIED"}
        </Chip>
      </View>
      {!!preview.full_name && (
        <Text style={[s.text, { fontWeight: "700" }]}>{preview.full_name}</Text>
      )}
      {!!(preview.email || preview.mobile) && (
        <Text style={s.muted}>{[preview.email, preview.mobile].filter(Boolean).join(" · ")}</Text>
      )}
      {preview.experience.map((e) => (
        <View key={e.title} style={{ gap: 2 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>{e.title}</Text>
          {!!e.dates && <Text style={s.muted}>{e.dates}</Text>}
          {e.bullets.map((b) => (
            <Text key={b} style={s.text}>
              · {b}
            </Text>
          ))}
        </View>
      ))}
      {preview.skills.map((g) => (
        <Text key={g.category} style={s.text}>
          <Text style={{ fontWeight: "600" }}>{g.category}: </Text>
          {g.items}
        </Text>
      ))}
      {preview.education.map((e) => (
        <Text key={`${e.degree}-${e.institution}`} style={s.text}>
          {e.degree}
          {!!e.institution && ` — ${e.institution}`}
          {!!e.dates && ` (${e.dates})`}
        </Text>
      ))}
      {!signedOff && (
        <Text style={s.small}>
          Built only from your quoted answers. Nothing has been added or polished.
        </Text>
      )}
    </Card>
  );
}

function CurrentQuestionCard({
  question,
  progressLabel,
  answer,
  setAnswer,
  busy,
  onSubmit,
}: {
  question: Question;
  progressLabel: string;
  answer: string;
  setAnswer: (v: string) => void;
  busy: boolean;
  onSubmit: (questionId: string) => void;
}) {
  return (
    <Card style={{ gap: 8 }}>
      <View style={[s.row, { gap: 8 }]}>
        <Chip>{SECTION_LABELS[question.section]}</Chip>
        <Text style={s.muted}>{progressLabel}</Text>
      </View>
      <Text style={[s.text, { fontWeight: "600" }]}>{question.prompt}</Text>
      <Text style={s.small}>{question.why}</Text>
      <Field
        label="Your answer"
        multiline
        value={answer}
        onChangeText={setAnswer}
        placeholder="Answer in your own words…"
      />
      <Button primary busy={busy} disabled={!answer.trim()} onPress={() => onSubmit(question.id)}>
        Save answer
      </Button>
    </Card>
  );
}

export function CvInterviewSheet({ onClose }: { onClose: () => void }) {
  const { api } = useWorkspace();
  const [view, setView] = useState<InterviewView | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await api.request<InterviewView>("/api/cv-interview/state"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const next = await api.request<InterviewView>(path, body);
      setView(next);
      setAnswer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const interview = view?.interview ?? null;
  const answered = view ? Object.values(view.interview?.answers ?? {}) : [];
  const progressLabel = view
    ? `Question ${Math.min(view.required_answered + 1, view.required_total)} of ${view.required_total}`
    : "";

  return (
    <Sheet
      title="Build your CV with an interview"
      subtitle="Answer in your own words. We quote you verbatim — never polish, never invent."
      onClose={onClose}
      wide
    >
      <ErrorNotice error={error} />
      {!view ? (
        <ActivityIndicator />
      ) : !interview ? (
        <View style={{ gap: 12 }}>
          <Text style={s.text}>
            No CV? No problem. I'll ask you a short set of questions — about you, your work, your
            skills, your education — and we'll build your CV together from your answers.
          </Text>
          <Text style={s.muted}>
            12 questions, about 10 required. Your words are quoted exactly as you say them.
          </Text>
          <Button primary busy={busy} onPress={() => void post("/api/cv-interview/start")}>
            Start the interview
          </Button>
        </View>
      ) : (
        <ScrollView style={{ gap: 14 }} contentContainerStyle={{ gap: 14, paddingBottom: 24 }}>
          {/* Section tabs */}
          {view.section_states && (
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              {(Object.keys(SECTION_LABELS) as SectionId[]).map((sid) => {
                const state = (view.section_states as Record<SectionId, SectionState>)[sid];
                return (
                  <Chip key={sid} tint={sectionTint(state)}>
                    {SECTION_LABELS[sid]} · {state}
                  </Chip>
                );
              })}
            </View>
          )}

          {/* Conflicts */}
          {view.open_conflicts.map((c) => (
            <Card key={c.id} style={{ gap: 8, borderColor: colors.danger, borderWidth: 1 }}>
              <Text style={[s.text, { fontWeight: "700" }]}>
                You gave two different answers for "{c.field.replace(/_/g, " ")}"
              </Text>
              <Text style={s.text}>Earlier: "{c.existing}"</Text>
              <Text style={s.text}>Then: "{c.incoming}"</Text>
              <Text style={s.muted}>
                Pick the right one. The field stays quarantined — nothing is drafted from it — until
                you choose.
              </Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  small
                  busy={busy}
                  onPress={() =>
                    void post("/api/cv-interview/resolve-conflict", {
                      conflict_id: c.id,
                      winner: "existing",
                    })
                  }
                >
                  Keep earlier
                </Button>
                <Button
                  small
                  busy={busy}
                  onPress={() =>
                    void post("/api/cv-interview/resolve-conflict", {
                      conflict_id: c.id,
                      winner: "incoming",
                    })
                  }
                >
                  Keep newer
                </Button>
              </View>
            </Card>
          ))}

          {/* Q&A history, chat-like */}
          {view.questions
            .filter((q) => interview.answers[q.field])
            .map((q) => {
              const a = interview.answers[q.field];
              return (
                <View key={q.id} style={{ gap: 6 }}>
                  <Card style={{ backgroundColor: colors.sky }}>
                    <Text style={s.text}>{q.prompt}</Text>
                    <Text style={s.small}>{SECTION_LABELS[q.section]}</Text>
                  </Card>
                  <View style={{ alignItems: "flex-end" }}>
                    <Card style={{ backgroundColor: colors.green, maxWidth: "92%" }}>
                      <Text style={s.text}>"{a.triple.quoted_statement}"</Text>
                      {a.quarantined && (
                        <Text style={[s.small, { color: colors.danger, fontWeight: "700" }]}>
                          Quarantined — resolve the conflict above
                        </Text>
                      )}
                    </Card>
                  </View>
                </View>
              );
            })}

          {/* Current question */}
          {view.current && interview.status !== "signed_off" && (
            <CurrentQuestionCard
              question={view.current}
              progressLabel={progressLabel}
              answer={answer}
              setAnswer={setAnswer}
              busy={busy}
              onSubmit={(qid) =>
                void post("/api/cv-interview/answer", {
                  question_id: qid,
                  answer: answer.trim(),
                })
              }
            />
          )}

          {/* Draft preview from question 3 */}
          {view.draft_preview && (
            <DraftPreview
              preview={view.draft_preview}
              signedOff={interview.status === "signed_off"}
            />
          )}

          {/* Blocked state */}
          {view.blocked_on.length > 0 && (
            <Card style={{ borderColor: colors.danger, borderWidth: 1 }}>
              <Text style={[s.text, { fontWeight: "700" }]}>Drafting is blocked</Text>
              <Text style={s.muted}>
                Quarantined fields: {view.blocked_on.join(", ")}. Resolve the conflicts above to
                continue.
              </Text>
            </Card>
          )}

          {/* Sign-off */}
          {interview.status === "ready_for_signoff" && (
            <Card style={{ gap: 8 }}>
              <Text style={[s.text, { fontWeight: "700" }]}>Ready for sign-off</Text>
              <Text style={s.text}>
                Completeness: {Math.round(view.completeness * 100)}% ({view.required_answered}/
                {view.required_total} required questions).
              </Text>
              <Text style={s.muted}>
                Fidelity summary: {answered.length} facts, every one a verbatim quote from you.
                They'll be written to your profile memory as interview-derived facts — provenance
                "interview", the weakest class — backed by the full transcript as evidence. A master
                resume draft will be rendered from your quotes only, marked UNVERIFIED. It never
                touches your immutable master resume.
              </Text>
              <Button primary busy={busy} onPress={() => void post("/api/cv-interview/sign-off")}>
                Sign off — write to my profile
              </Button>
            </Card>
          )}

          {interview.status === "signed_off" && (
            <Card style={{ gap: 8, borderColor: colors.green, borderWidth: 1 }}>
              <Text style={[s.text, { fontWeight: "700" }]}>Signed off</Text>
              <Text style={s.text}>
                Your answers are now in your profile memory as interview-derived facts, and a master
                resume draft has been rendered from your quotes.
              </Text>
              <Text style={s.muted}>
                The draft is unverified — review it before using it anywhere.
              </Text>
            </Card>
          )}
        </ScrollView>
      )}
    </Sheet>
  );
}
