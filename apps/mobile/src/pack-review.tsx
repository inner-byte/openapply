import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  MessageCircleWarning,
  Package,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Linking, Text, View } from "react-native";
import { ApplySection } from "./apply";
import { Button, Card, Chip, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export interface PackDocumentView {
  id: string;
  kind: "resume" | "cover" | "statement";
  format: "pdf" | "docx";
  filename: string;
  page_count: number;
  preview_urls: string[];
  content_url: string;
}

export interface PackView {
  id: string;
  application_id?: string;
  job_title: string;
  company: string;
  template_id: string;
  created_at: string;
  status: "pack_review" | "pack_approved" | "pack_drafting";
  revision_note?: string;
  documents: PackDocumentView[];
}

const KIND_LABEL: Record<PackDocumentView["kind"], string> = {
  resume: "Resume",
  cover: "Cover letter",
  statement: "Statement",
};

function statusWord(status: PackView["status"]) {
  if (status === "pack_approved") return "Approved";
  if (status === "pack_drafting") return "Changes requested";
  return "Needs review";
}

function statusChip(status: PackView["status"]) {
  if (status === "pack_approved") return <Chip tint={colors.green}>Approved</Chip>;
  if (status === "pack_drafting") return <Chip tint={colors.orange}>Changes requested</Chip>;
  return <Chip tint={colors.lavender}>Needs review</Chip>;
}

/** List of packs, shown inside the Apps screen. */
export function PacksScreen() {
  const { api, open } = useWorkspace();
  const [packs, setPacks] = useState<PackView[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api
      .request<PackView[]>("/api/packs")
      .then((list) => live && setPacks(list))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.heading}>Packs</Text>
      <ErrorNotice error={error} />
      {packs === null && <Text style={s.muted}>Loading packs…</Text>}
      {packs !== null && packs.length === 0 && (
        <Text style={s.muted}>
          No packs yet. When your agent drafts a resume, cover letter, or statement for a job, the
          finished pack appears here for your review.
        </Text>
      )}
      {(packs ?? []).map((p) => (
        <LinkRow
          key={p.id}
          icon={Package}
          title={`${p.company} — ${p.job_title}`}
          detail={`${p.documents.length} document${p.documents.length === 1 ? "" : "s"} · ${statusWord(p.status)} · ${new Date(p.created_at).toLocaleDateString()}`}
          onPress={() => open({ type: "pack", packId: p.id })}
        />
      ))}
    </View>
  );
}

/** Full pack review: clean page previews, page numbers, approve / request changes. */
export function PackReviewSheet({ packId }: { packId: string }) {
  const { api, refresh, close } = useWorkspace();
  const [pack, setPack] = useState<PackView | null>(null);
  const [docIndex, setDocIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [notesOpen, setNotesOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api
      .request<PackView>(`/api/packs/${packId}`)
      .then((p) => live && setPack(p))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, packId]);

  const doc = pack?.documents[docIndex];
  const pageCount = doc?.page_count ?? 1;
  const safePage = Math.min(Math.max(page, 1), pageCount);

  function selectDoc(index: number) {
    setDocIndex(index);
    setPage(1);
  }

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const updated = await api.request<PackView>(path, body);
      setPack(updated);
      setNotesOpen(false);
      setNote("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pending = pack?.status === "pack_review";
  return (
    <Sheet
      title={pack ? `${pack.company} — ${pack.job_title}` : "Pack review"}
      subtitle={
        pack
          ? `Rendered from the final ${pack.documents.map((d) => d.format.toUpperCase()).join(" + ")} bytes. Approve only what you would send.`
          : "Loading…"
      }
      onClose={close}
    >
      <ErrorNotice error={error} />
      {!pack && <Text style={s.muted}>Loading pack…</Text>}
      {pack && (
        <View style={{ gap: 14 }}>
          <View style={[s.row, { alignItems: "center" }]}>
            <View style={{ flex: 1 }}>{statusChip(pack.status)}</View>
            <Text style={s.muted}>{pack.template_id.replace(/-/g, " ")}</Text>
          </View>

          {pack.status === "pack_drafting" && !!pack.revision_note && (
            <Card>
              <Text style={s.small}>Your requested changes</Text>
              <Text style={s.text}>{pack.revision_note}</Text>
            </Card>
          )}

          {/* Document tabs */}
          <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
            {pack.documents.map((d, i) => (
              <Button key={d.id} small primary={i === docIndex} onPress={() => selectDoc(i)}>
                {KIND_LABEL[d.kind]}
              </Button>
            ))}
          </View>

          {doc && (
            <View style={{ gap: 10 }}>
              {/* Page pager */}
              <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
                <View style={[s.row, { gap: 8, alignItems: "center" }]}>
                  <Button
                    small
                    icon={ChevronLeft}
                    disabled={safePage <= 1}
                    onPress={() => setPage(safePage - 1)}
                  >
                    Previous
                  </Button>
                  <Text style={s.small}>
                    Page {safePage} of {pageCount}
                  </Text>
                  <Button
                    small
                    icon={ChevronRight}
                    disabled={safePage >= pageCount}
                    onPress={() => setPage(safePage + 1)}
                  >
                    Next
                  </Button>
                </View>
                <Button
                  small
                  icon={Download}
                  onPress={() => void Linking.openURL(api.url(doc.content_url))}
                >
                  Open {doc.format.toUpperCase()}
                </Button>
              </View>

              {/* Clean page preview, rendered from the real document bytes */}
              <View
                style={{
                  backgroundColor: "#FFFFFF",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "#E8EAED",
                  shadowColor: "#132631",
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.06,
                  shadowRadius: 12,
                  elevation: 2,
                  overflow: "hidden",
                }}
              >
                <Image
                  key={doc.preview_urls[safePage - 1]}
                  source={{ uri: api.url(doc.preview_urls[safePage - 1]) }}
                  style={{ width: "100%", aspectRatio: 210 / 297 }}
                  resizeMode="contain"
                  accessibilityLabel={`${KIND_LABEL[doc.kind]} page ${safePage} of ${pageCount}`}
                />
              </View>
              <View style={[s.row, { gap: 8, alignItems: "center" }]}>
                <FileText size={14} color={colors.muted} />
                <Text style={s.muted} numberOfLines={1}>
                  {doc.filename}
                </Text>
              </View>

              {pending && (
                <View style={{ gap: 10 }}>
                  {!notesOpen ? (
                    <View style={[s.row, { gap: 8 }]}>
                      <Button
                        style={{ flex: 1 }}
                        icon={MessageCircleWarning}
                        onPress={() => setNotesOpen(true)}
                      >
                        Request changes
                      </Button>
                      <Button
                        style={{ flex: 1 }}
                        primary
                        icon={Check}
                        busy={busy}
                        onPress={() => void act(`/api/packs/${pack.id}/approve`)}
                      >
                        Approve pack
                      </Button>
                    </View>
                  ) : (
                    <Card style={{ gap: 10 }}>
                      <Text style={s.text}>What should change?</Text>
                      <Field
                        label="Notes for the next draft"
                        value={note}
                        onChangeText={setNote}
                        placeholder="e.g. shorten the second paragraph, fix the job title"
                        multiline
                      />
                      <View style={[s.row, { gap: 8 }]}>
                        <Button style={{ flex: 1 }} onPress={() => setNotesOpen(false)}>
                          Cancel
                        </Button>
                        <Button
                          style={{ flex: 1 }}
                          primary
                          busy={busy}
                          onPress={() =>
                            void act(`/api/packs/${pack.id}/request-changes`, { note })
                          }
                        >
                          Send for revision
                        </Button>
                      </View>
                    </Card>
                  )}
                  <Text style={s.muted}>
                    Nothing is submitted anywhere. Approving marks the pack ready; the actual
                    application still needs your explicit submit approval.
                  </Text>
                </View>
              )}
              {pack.status === "pack_approved" && (
                <>
                  <Card>
                    <Text style={s.text}>
                      Approved. This pack is locked and ready whenever you choose to apply.
                    </Text>
                  </Card>
                  {pack.application_id && <ApplySection applicationId={pack.application_id} />}
                </>
              )}
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}
