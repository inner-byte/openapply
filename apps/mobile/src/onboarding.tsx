/**
 * Onboarding: three questions, no CV required to start.
 *
 * Screen 1 — the promise: OpenApply never applies without your word.
 * Screen 2 — who you are: name, countries of interest, optional avatar.
 * Screen 3 — what you're after: target titles, qualification level.
 *
 * Every field is skippable ("Skip for now" on screens 2–3; answers can be
 * refined later in Settings). On complete the answers land in preferences;
 * the name is stored as a profile memory.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MuseApi } from "./api";
import { AvatarPicker } from "./avatars";
import { Button, Card, colors, ErrorNotice, Field, s } from "./ui";

const COUNTRIES = [
  "Nigeria",
  "Ghana",
  "Kenya",
  "South Africa",
  "Egypt",
  "United Kingdom",
  "United States",
  "Canada",
  "Germany",
  "Netherlands",
  "France",
  "Ireland",
  "UAE",
  "Saudi Arabia",
  "Qatar",
  "India",
  "Singapore",
  "Australia",
  "Remote",
];

const QUALIFICATION_LEVELS = [
  {
    id: "none_manual",
    label: "Practical / hands-on",
    detail: "Manual, trade-assistant and hands-on roles — real skill, no certificate required.",
  },
  {
    id: "vocational",
    label: "Vocational / trade",
    detail: "Trade certificates, diplomas and apprenticeships.",
  },
  {
    id: "graduate",
    label: "Graduate",
    detail: "Bachelor's degree or equivalent.",
  },
  {
    id: "postgraduate",
    label: "Postgraduate",
    detail: "Master's, MBA, or higher.",
  },
  {
    id: "experienced_professional",
    label: "Experienced professional",
    detail: "Several years of professional experience.",
  },
];

function StepDots({ step }: { step: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            width: i === step ? 24 : 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: i === step ? colors.accent : colors.line,
          }}
        />
      ))}
    </View>
  );
}

function CountryChips({
  value,
  onToggle,
}: {
  value: string[];
  onToggle: (country: string) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {COUNTRIES.map((country) => {
        const active = value.includes(country);
        return (
          <Pressable
            key={country}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active }}
            accessibilityLabel={`${country}${active ? ", selected" : ""}`}
            onPress={() => onToggle(country)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 9,
              borderRadius: 20,
              borderWidth: 1.5,
              borderColor: active ? colors.accent : colors.line,
              backgroundColor: active ? colors.sky : colors.card,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: active ? "600" : "400",
                color: active ? colors.blueDark : colors.text,
              }}
            >
              {country}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function OnboardingFlow({ api, onDone }: { api: MuseApi; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [titles, setTitles] = useState("");
  const [qualification, setQualification] = useState("");
  const [avatar, setAvatar] = useState("open-ring");
  const [avatarPicked, setAvatarPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleCountry = (country: string) =>
    setCountries((prev) =>
      prev.includes(country) ? prev.filter((c) => c !== country) : [...prev, country],
    );

  async function finish() {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        onboarding_completed: true,
        onboarding_completed_at: new Date().toISOString(),
      };
      if (countries.length > 0) body.countries = countries;
      const titleList = titles
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (titleList.length > 0) body.titles_include = titleList;
      if (qualification) body.qualification_level = qualification;
      if (avatarPicked) body.avatar = avatar;
      await api.request("/api/preferences", body, "PUT");
      const cleanName = name.trim();
      if (cleanName) {
        await api.request(
          "/api/agent/memories",
          { text: `The user's name is ${cleanName}.` },
          "POST",
        );
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: "100%", maxWidth: 520, alignSelf: "center", gap: 20 }}>
          <StepDots step={step} />
          <ErrorNotice error={error} />

          {step === 0 && (
            <View style={{ gap: 16, alignItems: "center" }}>
              <Text style={[s.title, { fontSize: 28, textAlign: "center" }]}>
                OpenApply never applies without your word.
              </Text>
              <Text style={[s.muted, { textAlign: "center", fontSize: 16 }]}>
                No CV needed to start. Tell us a little about what you're looking for, and we'll do
                the heavy lifting — every application waits for your approval.
              </Text>
              <Button primary busy={busy} onPress={() => setStep(1)} style={{ marginTop: 8 }}>
                Get started
              </Button>
            </View>
          )}

          {step === 1 && (
            <View style={{ gap: 18 }}>
              <View style={{ gap: 6 }}>
                <Text style={[s.title, { fontSize: 24 }]}>Who are you?</Text>
                <Text style={s.muted}>Just the basics — everything here is optional.</Text>
              </View>
              <Field
                label="Your name"
                value={name}
                onChangeText={setName}
                placeholder="What should we call you?"
                autoCapitalize="words"
              />
              <View style={{ gap: 10 }}>
                <Text style={[s.small, { fontWeight: "600", color: colors.text, fontSize: 13 }]}>
                  Countries of interest
                </Text>
                <CountryChips value={countries} onToggle={toggleCountry} />
              </View>
              <View style={{ gap: 10 }}>
                <Text style={[s.small, { fontWeight: "600", color: colors.text, fontSize: 13 }]}>
                  Pick a mark{" "}
                  <Text style={{ fontWeight: "400", color: colors.muted }}>(optional)</Text>
                </Text>
                <AvatarPicker
                  value={avatar}
                  onSelect={(id) => {
                    setAvatar(id);
                    setAvatarPicked(true);
                  }}
                />
              </View>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                <Button primary busy={busy} onPress={() => setStep(2)} style={{ flex: 1 }}>
                  Continue
                </Button>
                <Button busy={busy} onPress={() => setStep(2)} style={{ flex: 1 }}>
                  Skip for now
                </Button>
              </View>
            </View>
          )}

          {step === 2 && (
            <View style={{ gap: 18 }}>
              <View style={{ gap: 6 }}>
                <Text style={[s.title, { fontSize: 24 }]}>What are you after?</Text>
                <Text style={s.muted}>
                  This tunes which jobs we surface. Skip anything — you can refine it in Settings.
                </Text>
              </View>
              <Field
                label="Target job titles"
                value={titles}
                onChangeText={setTitles}
                placeholder="e.g. Accountant, Data Analyst, Driver"
              />
              <View style={{ gap: 10 }}>
                <Text style={[s.small, { fontWeight: "600", color: colors.text, fontSize: 13 }]}>
                  Qualification level
                </Text>
                {QUALIFICATION_LEVELS.map((level) => {
                  const active = qualification === level.id;
                  return (
                    <Pressable
                      key={level.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active }}
                      accessibilityLabel={level.label}
                      onPress={() => setQualification(active ? "" : level.id)}
                      style={{ opacity: busy ? 0.6 : 1 }}
                      disabled={busy}
                    >
                      <Card
                        style={{
                          gap: 2,
                          borderWidth: 1.5,
                          borderColor: active ? colors.accent : colors.line,
                          backgroundColor: active ? colors.sky : colors.card,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 15,
                            fontWeight: active ? "600" : "500",
                            color: colors.text,
                          }}
                        >
                          {level.label}
                        </Text>
                        <Text style={s.small}>{level.detail}</Text>
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                <Button primary busy={busy} onPress={() => void finish()} style={{ flex: 1 }}>
                  Finish
                </Button>
                <Button busy={busy} onPress={() => void finish()} style={{ flex: 1 }}>
                  Skip for now
                </Button>
              </View>
              <Button small busy={busy} onPress={() => setStep(1)}>
                Back
              </Button>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
