const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 20 * 60 * 1000);
const BUILD_TOKEN = process.env.BUILD_TOKEN || "";
const MAX_BODY = process.env.MAX_BODY || "300mb";
const ROOT = path.resolve(__dirname, "..");

app.use(express.json({ limit: MAX_BODY }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Build-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function authorized(req) {
  if (!BUILD_TOKEN) return true;
  const header = req.get("X-Build-Token") || "";
  const auth = req.get("Authorization") || "";
  return header === BUILD_TOKEN || auth === "Bearer " + BUILD_TOKEN;
}

function safeName(value) {
  return String(value || "flay-app").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function safeExtract(zipPath, outDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const raw = String(entry.entryName || "").replace(/\\/g, "/");
    if (!raw || raw.startsWith("/") || raw.split("/").includes("..")) {
      throw new Error("Unsafe ZIP path rejected: " + raw);
    }
  }
  zip.extractAllTo(outDir, true);
}

async function findFile(root, predicate) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".gradle", "build"].includes(entry.name)) queue.push(full);
      } else if (predicate(full, entry.name)) return full;
    }
  }
  return null;
}

async function findGradleRoot(workDir) {
  const wrapper = await findFile(workDir, (full, name) => name === "gradlew");
  if (wrapper) return path.dirname(wrapper);
  const settings = await findFile(workDir, (full, name) =>
    name === "settings.gradle" || name === "settings.gradle.kts"
  );
  return settings ? path.dirname(settings) : null;
}

async function collectApks(workDir) {
  const found = [];
  const queue = [workDir];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (![".git", ".gradle", "node_modules"].includes(entry.name)) queue.push(full);
      } else if (entry.name.toLowerCase().endsWith(".apk")) found.push(full);
    }
  }
  return found;
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd, env, timeout: BUILD_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const log = [stdout, stderr].filter(Boolean).join("\n");
      if (error) {
        const e = new Error(error.killed ? "Build timed out." : (error.message || "Build failed."));
        e.code = error.code;
        e.log = log;
        return reject(e);
      }
      resolve(log);
    });
  });
}

async function buildProject(input) {
  const archiveBase64 = input && input.archiveBase64;
  if (!archiveBase64 || typeof archiveBase64 !== "string") throw new Error("archiveBase64 is required.");

  const id = crypto.randomBytes(10).toString("hex");
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flay-build-" + id + "-"));
  const zipPath = path.join(workDir, "project.zip");
  const projectDir = path.join(workDir, "project");

  try {
    await fsp.mkdir(projectDir);
    const data = Buffer.from(archiveBase64, "base64");
    if (!data.length) throw new Error("The uploaded project archive is empty.");
    await fsp.writeFile(zipPath, data);
    safeExtract(zipPath, projectDir);

    const actualRoot = await findGradleRoot(projectDir);
    if (!actualRoot) throw new Error("No Android Gradle project was found. The ZIP must contain settings.gradle(.kts) or gradlew.");

    const gradlew = path.join(actualRoot, "gradlew");
    const hasWrapper = fs.existsSync(gradlew);
    const command = hasWrapper ? gradlew : "gradle";
    const args = ["assembleDebug", "--no-daemon", "--stacktrace"];
    if (hasWrapper) { try { await fsp.chmod(gradlew, 0o755); } catch (_) {} }

    const env = {
      ...process.env,
      CI: "true",
      GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || path.join(os.tmpdir(), "flay-gradle-cache"),
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "/opt/android-sdk",
      ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "/opt/android-sdk"
    };

    const log = await run(command, args, actualRoot, env);
    const apks = await collectApks(actualRoot);
    if (!apks.length) {
      const e = new Error("Gradle completed but no APK was produced.");
      e.log = log;
      throw e;
    }
    apks.sort((a, b) => (/debug/i.test(a) ? 0 : 1) - (/debug/i.test(b) ? 0 : 1));
    return { apkPath: apks[0], log, projectName: safeName(input.name) };
  } catch (error) {
    if (!error.log) error.log = error.stack || String(error);
    throw error;
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "flay-android-build-server",
    androidSdk: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "/opt/android-sdk"
  });
});

app.post("/build", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized build request." });

  let result;
  try {
    result = await buildProject(req.body || {});
    const apk = await fsp.readFile(result.apkPath);
    const filename = result.projectName + "-debug.apk";
    res.status(200);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", 'attachment; filename="' + filename + '"');
    res.setHeader("Content-Length", apk.length);
    res.setHeader("X-Flay-Build-Status", "success");
    return res.end(apk);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : "Build failed.",
      log: String(error && error.log ? error.log : "").slice(-30000)
    });
  } finally {
    try {
      if (result && result.apkPath) {
        const marker = result.apkPath.indexOf(path.sep + "project" + path.sep);
        if (marker > 0) await fsp.rm(result.apkPath.slice(0, marker), { recursive: true, force: true });
      }
    } catch (_) {}
  }
});

app.use(express.static(ROOT, { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log("Flay AI build server listening on 0.0.0.0:" + PORT);
});
