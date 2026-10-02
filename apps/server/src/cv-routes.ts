/**
 * CV interview routes: conversational CV builder for users without a CV.
 */
import type { Hono } from "hono";
import { z } from "zod";
import {
  answerQuestion,
  type CvInterviewDeps,
  interviewView,
  resolveInterviewConflict,
  signOffInterview,
  startInterview,
} from "./cv-interview.ts";
import type { Store } from "./db.ts";
import type { DomainService } from "./domain.ts";
import { renderResume } from "./foundry/render.ts";
import type { ProfileStore } from "./profile.ts";

const answerSchema = z.object({
  question_id: z.string().min(1).max(80),
  answer: z.string().min(1).max(2000),
});

const resolveSchema = z.object({
  conflict_id: z.string().min(1).max(80),
  winner: z.enum(["existing", "incoming"]),
});

export function registerCvRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  domain: DomainService,
  profileStore: ProfileStore,
) {
  const deps: CvInterviewDeps = {
    db,
    recordEvent: (owner, type, payload) => domain.recordEvent(owner, type, payload),
    profileStore,
    renderResume: (templateId, content) => renderResume(templateId, content),
  };

  app.post("/api/cv-interview/start", async (c) => {
    await startInterview(deps, c.get("owner"));
    return c.json(await interviewView(deps, c.get("owner")), 201);
  });

  app.post("/api/cv-interview/answer", async (c) => {
    const body = answerSchema.parse(await c.req.json());
    const { conflict } = await answerQuestion(deps, c.get("owner"), body.question_id, body.answer);
    return c.json({ ...(await interviewView(deps, c.get("owner"))), conflict });
  });

  app.get("/api/cv-interview/state", async (c) => {
    return c.json(await interviewView(deps, c.get("owner")));
  });

  app.post("/api/cv-interview/resolve-conflict", async (c) => {
    const body = resolveSchema.parse(await c.req.json());
    await resolveInterviewConflict(deps, c.get("owner"), body.conflict_id, body.winner);
    return c.json(await interviewView(deps, c.get("owner")));
  });

  app.post("/api/cv-interview/sign-off", async (c) => {
    const { interview, resume } = await signOffInterview(deps, c.get("owner"));
    return c.json({ interview, resume });
  });
}
