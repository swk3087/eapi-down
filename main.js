import express from "express";
import tar from "tar";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "30mb" })); // content JSON이 커질 수 있어서 넉넉히

const ORIGIN = "https://playentry.org";

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function toAbsoluteUrl(u) {
  if (!u || typeof u !== "string") return null;
  if (isHttpUrl(u)) return u;
  if (u.startsWith("/")) return ORIGIN + u;
  return null;
}

/**
 * Entry content(JSON)에서 에셋 URL 후보를 수집:
 * - key 이름이 fileurl / fileUrl / thumbUrl / thumbURL 같은 것
 * - string 값이 "/.../image/...", "/.../sound/..." 또는 "/lib/..." 형태인 것
 */
function collectAssetUrls(content) {
  const urls = new Set();

  const walk = (v, k = "") => {
    if (!v) return;

    if (typeof v === "string") {
      const s = v;

      // 1) 키 기반(가장 안정적)
      if (typeof k === "string") {
        const kk = k.toLowerCase();
        if (["fileurl", "fileurl", "thumburl", "thumburl"].includes(kk)) {
          const abs = toAbsoluteUrl(s);
          if (abs) urls.add(abs);
          return;
        }
      }

      // 2) 값 패턴 기반(보조)
      if (s.startsWith("/")) {
        if (s.includes("/image/") || s.includes("/sound/") || s.includes("/thumb/") || s.startsWith("/lib/")) {
          urls.add(ORIGIN + s);
        }
      } else if (isHttpUrl(s)) {
        if (s.includes("/image/") || s.includes("/sound/") || s.includes("/thumb/") || s.includes("/lib/")) {
          urls.add(s);
        }
      }
      return;
    }

    if (Array.isArray(v)) {
      for (const item of v) walk(item, k);
      return;
    }

    if (typeof v === "object") {
      for (const [key, val] of Object.entries(v)) walk(val, key);
    }
  };

  walk(content);
  return [...urls];
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function safeName(name) {
  const base = (name || "project").toString();
  return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "project";
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed ${res.status}: ${url}`);

  await ensureDir(path.dirname(outPath));

  // Node fetch body -> file
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(outPath);
    res.body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    res.body.pipe(ws);
  });
}

function urlToTempRelativePath(assetUrl) {
  // https://playentry.org/e4/94/image/xxx.png -> "e4/94/image/xxx.png"
  // https://playentry.org/lib/entry-js/... -> "lib/entry-js/..."
  const u = new URL(assetUrl);
  return u.pathname.replace(/^\//, "");
}

/**
 * content를 받아 .ent 생성 후 파일 경로 반환
 */
async function buildEntFromContent({ content, name }) {
  const id = crypto.randomBytes(8).toString("hex");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `entry-ent-${id}-`));
  const tempDir = path.join(workDir, "temp");
  await ensureDir(tempDir);

  // 1) project.json 저장
  await fs.writeFile(path.join(tempDir, "project.json"), JSON.stringify(content, null, 2), "utf-8");

  // 2) 에셋 다운로드
  const assets = collectAssetUrls(content);

  // 너무 많으면 서버가 터질 수 있으니 안전장치(필요시 조정)
  if (assets.length > 2000) {
    throw new Error(`assets too many: ${assets.length}`);
  }

  for (const assetUrl of assets) {
    const rel = urlToTempRelativePath(assetUrl);
    const outPath = path.join(tempDir, rel);
    await downloadToFile(assetUrl, outPath);
  }

  // 3) tar.gz로 .ent 만들기
  const outName = safeName(name);
  const outEnt = path.join(workDir, `${outName}.ent`);

  await tar.c(
    {
      file: outEnt,
      gzip: { memLevel: 6 },
      cwd: workDir,
      portable: true,
      filter: (_p, stat) => {
        try {
          return !stat.isSymbolicLink();
        } catch {
          return false;
        }
      },
    },
    ["temp"]
  );

  return { outEnt, workDir, assetCount: assets.length, fileName: `${outName}.ent` };
}

/**
 * POST /ent
 * body:
 *  {
 *    "content": { ... Entry project json ... },
 *    "name": "테스트작품"   // optional
 *  }
 */
app.post("/ent", async (req, res) => {
  try {
    const { content, name } = req.body ?? {};
    if (!content || typeof content !== "object") {
      return res.status(400).json({ ok: false, error: "body.content (object) is required" });
    }

    const { outEnt, workDir, assetCount, fileName } = await buildEntFromContent({
      content,
      name: name || content?.name || "project",
    });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("X-Asset-Count", String(assetCount));

    // 파일 스트리밍 후 임시폴더 정리
    res.sendFile(outEnt, async (err) => {
      // cleanup
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {}
      if (err) console.error(err);
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Entry .ent server listening on :3000"));
