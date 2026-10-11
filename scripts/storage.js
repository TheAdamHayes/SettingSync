// Reading and writing the shared JSON files that every world on this Foundry install can see.
// On The Forge this is your Assets Library; self-hosted it's the Data folder.
import { MODULE_ID, SHARED_FOLDER, SUBFOLDERS, CONFIG_FILE } from "./constants.js";

function FP() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

export function isForge() {
  return typeof globalThis.ForgeVTT !== "undefined" && !!globalThis.ForgeVTT.usingTheForge;
}

export function fileSource() {
  return isForge() ? "forgevtt" : "data";
}

const knownDirs = new Set();

async function ensureDir(path) {
  if (knownDirs.has(path)) return;
  const parts = path.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (knownDirs.has(current)) continue;
    try {
      await FP().browse(fileSource(), current);
    } catch {
      try { await FP().createDirectory(fileSource(), current, {}); }
      catch (err) {
        // "already exists" is fine; anything else is reported by the upload itself.
        console.debug(`${MODULE_ID} | createDirectory ${current}:`, err?.message ?? err);
      }
    }
    knownDirs.add(current);
  }
}

/** List the files in a shared subfolder. Returns [] if it doesn't exist yet. */
export async function listFiles(folder) {
  try {
    const res = await FP().browse(fileSource(), folder);
    return res?.files ?? [];
  } catch {
    return [];
  }
}

function baseName(path) {
  return decodeURIComponent(String(path).split("?")[0].split("/").pop());
}

/** Fetch and parse a JSON file by its path or URL (cache-busted). */
export async function readJsonUrl(pathOrUrl) {
  const sep = pathOrUrl.includes("?") ? "&" : "?";
  const res = await fetch(`${pathOrUrl}${sep}ahss=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not read ${pathOrUrl} (HTTP ${res.status})`);
  return res.json();
}

/** Read a named file from a folder, or null if it isn't there. */
export async function readJson(folder, name) {
  const files = await listFiles(folder);
  const match = files.find(f => baseName(f) === name);
  if (!match) return null;
  try { return await readJsonUrl(match); }
  catch (err) { console.warn(`${MODULE_ID} |`, err); return null; }
}

/** Write an object as a JSON file into a shared folder. Returns the stored path/URL. */
export async function writeJson(folder, name, data) {
  await ensureDir(folder);
  const file = new File([JSON.stringify(data, null, 1)], name, { type: "application/json" });
  const res = await FP().upload(fileSource(), folder, file, {}, { notify: false });
  if (!res || res.status === "error" || res === false) {
    throw new Error(`Upload of ${folder}/${name} failed${res?.message ? `: ${res.message}` : ""}`);
  }
  return res.path ?? `${folder}/${name}`;
}

// ---------- Typed helpers ----------

export async function readConfig() {
  return (await readJson(SHARED_FOLDER, CONFIG_FILE)) ?? {};
}

export async function writeConfig(config) {
  return writeJson(SHARED_FOLDER, CONFIG_FILE, config);
}

/** All world reports ("heartbeats"), keyed by world id. */
export async function readWorldReports() {
  const files = (await listFiles(SUBFOLDERS.worlds)).filter(f => baseName(f).endsWith(".json"));
  const reports = {};
  await Promise.all(files.map(async f => {
    try {
      const r = await readJsonUrl(f);
      if (r?.worldId) reports[r.worldId] = r;
    } catch (err) { console.warn(`${MODULE_ID} | bad world report ${f}`, err); }
  }));
  return reports;
}

export async function writeWorldReport(report) {
  return writeJson(SUBFOLDERS.worlds, `${report.worldId}.json`, report);
}

export async function writeSnapshot(snapshot) {
  return writeJson(SUBFOLDERS.snapshots, `${snapshot.id}.json`, snapshot);
}

export async function readSnapshot(fileOrUrl) {
  return readJsonUrl(fileOrUrl);
}

export async function writeBackup(worldId, backup) {
  return writeJson(`${SUBFOLDERS.backups}/${worldId}`, `${backup.id}.json`, backup);
}

export async function listBackups(worldId) {
  const files = await listFiles(`${SUBFOLDERS.backups}/${worldId}`);
  return files.filter(f => baseName(f).endsWith(".json"))
    .map(f => ({ path: f, name: baseName(f) }))
    .sort((a, b) => b.name.localeCompare(a.name));
}
