import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

const app = express();
const port = Number(process.env.PORT || 10000);
const root = path.dirname(fileURLToPath(import.meta.url));
const sessionCookie = "portfolio_editor_session";
const stateCookie = "portfolio_editor_state";
const sessionLifetime = 8 * 60 * 60;
const config = {
  appId: process.env.GITHUB_APP_ID,
  clientId: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  privateKey: process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n"),
  installationId: process.env.GITHUB_INSTALLATION_ID,
  owner: process.env.GITHUB_OWNER || "faqihhhhh",
  repo: process.env.GITHUB_REPO || "faqihhhhh.github.io",
  branch: process.env.GITHUB_BRANCH || "main",
  allowedUser: (process.env.ALLOWED_GITHUB_USER || "faqihhhhh").toLowerCase(),
  callbackUrl: process.env.GITHUB_CALLBACK_URL,
  appOrigin: process.env.APP_ORIGIN,
  sessionSecret: process.env.SESSION_SECRET,
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sign(value) {
  const secret = required("SESSION_SECRET", config.sessionSecret);
  if (Buffer.byteLength(secret) < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes");
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function encodeSigned(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decodeSigned(value) {
  if (!value || typeof value !== "string") return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function currentUser(req) {
  const session = decodeSigned(cookies(req)[sessionCookie]);
  if (!session || session.exp < Date.now() || session.login?.toLowerCase() !== config.allowedUser) return null;
  return session.login;
}

function requireLogin(req, res, next) {
  const login = currentUser(req);
  if (!login) return res.status(401).json({ error: "Silakan masuk dengan GitHub terlebih dahulu." });
  req.githubLogin = login;
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!config.appOrigin || origin !== config.appOrigin) {
    return res.status(403).json({ error: "Asal permintaan tidak diizinkan." });
  }
  next();
}

function validateContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Konten harus berupa objek JSON.";
  const strings = ["username", "name", "headline", "location", "cv", "about"];
  for (const key of strings) if (typeof value[key] !== "string") return `Kolom ${key} harus berupa teks.`;
  if (typeof value.openToWork !== "boolean") return "Kolom openToWork harus berupa true atau false.";
  for (const key of ["experience", "education", "skills", "contact", "projects"]) {
    if (!Array.isArray(value[key])) return `Kolom ${key} harus berupa daftar.`;
  }
  if (value.username.toLowerCase() !== config.owner.toLowerCase()) return "Username portofolio harus sama dengan pemilik repo.";
  const hasTextFields = (items, keys) => items.every(item => item && typeof item === "object" && keys.every(key => typeof item[key] === "string"));
  if (!hasTextFields(value.experience, ["title", "org", "period", "desc"])) return "Format pengalaman tidak valid.";
  if (!hasTextFields(value.education, ["title", "org", "period", "desc"])) return "Format pendidikan tidak valid.";
  if (!value.skills.every(item => typeof item === "string")) return "Setiap keahlian harus berupa teks.";
  const validUrl = (value, schemes = ["http:", "https:"], allowRelative = false) => {
    if (!value) return true;
    if (allowRelative && /^[\w./#-]+$/.test(value) && !value.startsWith("//") && !value.split("/").includes("..")) return true;
    try { return schemes.includes(new URL(value).protocol); } catch { return false; }
  };
  if (!validUrl(value.cv, ["http:", "https:"], true)) return "Tautan CV harus berupa URL HTTP/HTTPS atau jalur file relatif yang aman.";
  if (value.contact.some(item => !item || typeof item.label !== "string" || typeof item.value !== "string" || !validUrl(item.href, ["http:", "https:", "mailto:"]))) {
    return "Setiap kontak perlu label, nilai, dan tautan HTTP, HTTPS, atau mailto yang valid.";
  }
  if (value.projects.some(project => !project || typeof project.name !== "string" || !["public", "private"].includes(project.visibility) || !validUrl(project.demo) || !Array.isArray(project.stack) || !project.stack.every(item => typeof item === "string") || !hasTextFields([project], ["summary", "purpose", "problem", "commercial", "failure", "status", "repo"]))) {
    return "Setiap proyek perlu nama, visibilitas public/private, dan tautan demo HTTP/HTTPS yang valid.";
  }
  return null;
}

async function githubInstallationClient() {
  const auth = createAppAuth({
    appId: required("GITHUB_APP_ID", config.appId),
    privateKey: required("GITHUB_PRIVATE_KEY", config.privateKey),
    installationId: required("GITHUB_INSTALLATION_ID", config.installationId),
  });
  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

async function getContent(octokit) {
  const response = await octokit.rest.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path: "content.json",
    ref: config.branch,
  });
  if (Array.isArray(response.data) || response.data.type !== "file") throw new Error("content.json is not a file");
  return {
    sha: response.data.sha,
    content: JSON.parse(Buffer.from(response.data.content, "base64").toString("utf8")),
  };
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => res.redirect("/edit/"));
app.get("/edit", (_req, res) => res.redirect("/edit/"));
app.get("/edit/", (_req, res) => res.sendFile(path.join(root, "public", "edit.html")));

app.get("/auth/github", (_req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString("base64url");
    const cookieValue = encodeSigned({ state, exp: Date.now() + 10 * 60 * 1000 });
    const callback = required("GITHUB_CALLBACK_URL", config.callbackUrl);
    const clientId = required("GITHUB_CLIENT_ID", config.clientId);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("state", state);
    res.setHeader("Set-Cookie", cookieHeader(stateCookie, cookieValue, 600));
    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

app.get("/auth/github/callback", async (req, res, next) => {
  try {
    const savedState = decodeSigned(cookies(req)[stateCookie]);
    res.setHeader("Set-Cookie", cookieHeader(stateCookie, "", 0));
    if (!savedState || savedState.exp < Date.now() || !req.query.state || savedState.state !== req.query.state) {
      return res.status(400).send("Sesi login tidak valid. Silakan ulangi login.");
    }
    if (req.query.error || typeof req.query.code !== "string") return res.redirect("/edit/?login=cancelled");

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: required("GITHUB_CLIENT_ID", config.clientId),
        client_secret: required("GITHUB_CLIENT_SECRET", config.clientSecret),
        code: req.query.code,
        redirect_uri: required("GITHUB_CALLBACK_URL", config.callbackUrl),
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error("GitHub login token exchange failed");

    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "Faqih-Portfolio-Editor" },
    });
    if (!userResponse.ok) throw new Error("GitHub account verification failed");
    const user = await userResponse.json();
    if (user.login?.toLowerCase() !== config.allowedUser) return res.status(403).send("Akun GitHub ini tidak diizinkan mengedit portofolio.");

    const session = encodeSigned({ login: user.login, exp: Date.now() + sessionLifetime * 1000 });
    res.setHeader("Set-Cookie", [cookieHeader(stateCookie, "", 0), cookieHeader(sessionCookie, session, sessionLifetime)]);
    res.redirect("/edit/");
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", requireSameOrigin, (_req, res) => {
  res.setHeader("Set-Cookie", cookieHeader(sessionCookie, "", 0));
  res.status(204).end();
});

app.get("/api/session", (req, res) => {
  const login = currentUser(req);
  res.json({ authenticated: Boolean(login), login });
});

app.get("/api/content", requireLogin, async (_req, res, next) => {
  try {
    const { content, sha } = await getContent(await githubInstallationClient());
    res.set("Cache-Control", "no-store").json({ content, sha });
  } catch (error) {
    next(error);
  }
});

app.put("/api/content", requireSameOrigin, requireLogin, async (req, res, next) => {
  try {
    const submitted = req.body?.content;
    const problem = validateContent(submitted);
    if (problem) return res.status(400).json({ error: problem });
    const octokit = await githubInstallationClient();
    const { sha: currentSha } = await getContent(octokit);
    if (!req.body.sha || req.body.sha !== currentSha) {
      return res.status(409).json({ error: "Konten di GitHub berubah sejak terakhir dimuat. Muat ulang sebelum menyimpan." });
    }
    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.owner,
      repo: config.repo,
      path: "content.json",
      branch: config.branch,
      sha: currentSha,
      message: "Update portfolio content",
      content: Buffer.from(`${JSON.stringify(submitted, null, 2)}\n`, "utf8").toString("base64"),
    });
    res.json({ ok: true, sha: response.data.content.sha, commit: response.data.commit.html_url });
  } catch (error) {
    if (error.status === 409 || error.status === 422) return res.status(409).json({ error: "Konten berubah di GitHub. Muat ulang sebelum menyimpan lagi." });
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Editor backend request failed:", error.message);
  res.status(500).json({ error: "Terjadi kesalahan pada backend editor." });
});

app.listen(port, "0.0.0.0", () => console.log(`Portfolio editor listening on 0.0.0.0:${port}`));
