import express from "express";
import tar from "tar";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "30mb" }));

const ORIGIN = "https://playentry.org";

function parseEntryIdFromUrl(input) {
  const u = new URL(input);

  // 지원: /project/<id> , /ws/<id>
  const m = u.pathname.match(/^\/(project|ws)\/([0-9a-f]{24,})/i);
  if (!m) throw new Error("지원하지 않는 URL 형식입니다. (/project/<id> 또는 /ws/<id>)");
  return { kind: m[1].toLowerCase(), id: m[2] };
}

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}
function toAbsoluteUrl(u) {
  if (!u || typeof u !== "string") return null;
  if (isHttpUrl(u)) return u;
  if (u.startsWith("/")) return ORIGIN + u;
  return null;
}

function collectAssetUrls(content) {
  const urls = new Set();

  const walk = (v, k = "") => {
    if (!v) return;

    if (typeof v === "string") {
      const s = v;
      const kk = String(k).toLowerCase();

      // 키 기반
      if (kk === "fileurl" || kk === "thumburl") {
        const abs = toAbsoluteUrl(s);
        if (abs) urls.add(abs);
        return;
      }

      // 값 패턴 기반(보조)
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

    if (Array.isArray(v)) return v.forEach((x) => walk(x, k));
    if (typeof v === "object") Object.entries(v).forEach(([key, val]) => walk(val, key));
  };

  walk(content);
  return [...urls];
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed ${res.status}: ${url}`);

  await ensureDir(path.dirname(outPath));

  await new Promise((resolve, reject) => {
    const ws = createWriteStream(outPath);
    res.body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    res.body.pipe(ws);
  });
}

function urlToTempRelativePath(assetUrl) {
  const u = new URL(assetUrl);
  return u.pathname.replace(/^\//, "");
}

function safeName(name) {
  const base = (name || "project").toString();
  return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "project";
}

async function buildEntFromContent({ content, name }) {
  const id = crypto.randomBytes(8).toString("hex");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `entry-ent-${id}-`));
  const tempDir = path.join(workDir, "temp");
  await ensureDir(tempDir);

  await fs.writeFile(path.join(tempDir, "project.json"), JSON.stringify(content, null, 2), "utf-8");

  const assets = collectAssetUrls(content);
  if (assets.length > 2000) throw new Error(`assets too many: ${assets.length}`);

  for (const assetUrl of assets) {
    const rel = urlToTempRelativePath(assetUrl);
    await downloadToFile(assetUrl, path.join(tempDir, rel));
  }

  const outName = safeName(name);
  const outEnt = path.join(workDir, `${outName}.ent`);

  await tar.c(
    {
      file: outEnt,
      gzip: { memLevel: 6 },
      cwd: workDir,
      portable: true,
      filter: (_p, stat) => {
        try { return !stat.isSymbolicLink(); } catch { return false; }
      },
    },
    ["temp"]
  );

  return { outEnt, workDir, assetCount: assets.length, fileName: `${outName}.ent` };
}

// ✅ 핵심: 공개 작품이면 여기서 JSON을 받아옴
async function fetchProjectContentById(projectId) {
  const res = await fetch(`https://playentry.org/api/project/${projectId}`, {
    headers: { accept: "application/json, text/plain, */*" },
  });

  if (!res.ok) {
    // 비공개/로그인필요 등
    throw new Error(`프로젝트 JSON 조회 실패(${res.status}). 공개 작품이 아니거나 로그인 필요일 수 있어요.`);
  }

  const data = await res.json();

  // 응답 구조는 경우에 따라 달라서, 흔한 케이스들을 유연하게 처리
  const content =
    data?.content ??
    data?.data?.content ??
    data?.project?.content ??
    data?.data?.project?.content ??
    data?.project ??
    data?.data?.project ??
    null;

  if (!content || typeof content !== "object") {
    throw new Error("프로젝트 JSON 응답에서 content를 찾지 못했어요. 응답 구조를 확인해야 합니다.");
  }

  const name =
    data?.name ??
    data?.data?.name ??
    content?.name ??
    "project";

  return { content, name };
}

/**
 * GET /down/url?u=<entry url>
 * 지원:
 *  - https://playentry.org/project/<id>
 *  - https://playentry.org/ws/<id>
 */
app.get("/down/url", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).json({ ok: false, error: "query u is required" });

    const { id } = parseEntryIdFromUrl(String(u));

    // 여기서는 ws든 project든 동일하게 api/project/{id}를 먼저 시도
    const { content, name } = await fetchProjectContentById(id);

    const { outEnt, workDir, assetCount, fileName } = await buildEntFromContent({ content, name });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("X-Asset-Count", String(assetCount));

    res.sendFile(outEnt, async (err) => {
      try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}
      if (err) console.error(err);
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// (선택) POST /ent : content를 직접 받아서 만드는 방식(로그인 필요 작품 대응)
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

    res.sendFile(outEnt, async (err) => {
      try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}
      if (err) console.error(err);
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.listen(3000, () => console.log("listening on :3000"));
