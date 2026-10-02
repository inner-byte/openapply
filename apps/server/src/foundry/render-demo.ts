// Demo render:
//   node --experimental-strip-types render-demo.ts resume <templateId> <outDir>
//   node --experimental-strip-types render-demo.ts cover <templateId> <outDir>
//   node --experimental-strip-types render-demo.ts statement <templateId> <outDir>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { renderCover, renderResume, renderStatement } from "./render.ts";

const kind = process.argv[2] ?? "resume";
const templateId = process.argv[3] ?? "template-one";
const outDir = process.argv[4] ?? "/tmp/oa-foundry-demo";

const fixtureName =
  kind === "cover"
    ? "demo-cover.json"
    : kind === "statement"
      ? "demo-statement.json"
      : "demo-resume.json";
const fixture = JSON.parse(
  await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url), "utf-8"),
);
const render =
  kind === "cover" ? renderCover : kind === "statement" ? renderStatement : renderResume;
const result = await render(templateId, fixture);
await mkdir(outDir, { recursive: true });
const slug = `${kind}-${templateId}`;
await writeFile(`${outDir}/${slug}.pdf`, result.pdf);
for (let i = 0; i < result.pages.length; i++)
  await writeFile(`${outDir}/${slug}-p${i + 1}.png`, result.pages[i]);
console.log(JSON.stringify({ kind, templateId, pageCount: result.pageCount }));
