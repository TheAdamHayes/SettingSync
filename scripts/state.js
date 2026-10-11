// Capturing this world's state and writing changes into it.
// Users are never touched: User documents are never read or written, and
// user-scoped settings (settings that belong to a specific player) are skipped.
import { MODULE_ID, FORMAT, DEFAULT_EXCLUSIONS } from "./constants.js";
import { parsePatterns, buildWrites, diffStates } from "./sync-core.js";
import * as store from "./storage.js";

export function worldSettingsCollection() {
  return game.settings.storage.get("world");
}

function rawValue(settingDoc) {
  const v = settingDoc._source?.value;
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

/** Snapshot of this world: installed modules (+ enabled or not) and all world-level settings. */
export function captureState() {
  const modules = {};
  for (const m of game.modules) {
    modules[m.id] = { title: m.title, version: m.version ?? null, active: !!m.active };
  }
  const settings = {};
  for (const s of worldSettingsCollection()) {
    if (s.user) continue; // user-scoped: belongs to a player, never synced
    settings[s.key] = rawValue(s);
  }
  return {
    format: FORMAT,
    source: {
      worldId: game.world.id,
      worldTitle: game.world.title,
      foundry: game.version,
      system: { id: game.system.id, version: game.system.version }
    },
    modules,
    settings
  };
}

export function localExclusions() {
  return parsePatterns(game.settings.get(MODULE_ID, "exclusions") ?? DEFAULT_EXCLUSIONS);
}

export function diffAgainstLocal(masterState, sourceExclusions = []) {
  return diffStates(masterState, captureState(), {
    exclusions: localExclusions(),
    sourceExclusions,
    selfModuleId: MODULE_ID,
    localSystem: { id: game.system.id, version: game.system.version }
  });
}

/** Friendly label for a setting key ("Module Title: Setting Name"). */
export function settingLabel(key) {
  const cfg = game.settings.settings.get(key);
  const ns = key.split(".")[0];
  const nsTitle = ns === "core" ? "Core" : (ns === game.system.id ? game.system.title : (game.modules.get(ns)?.title ?? ns));
  let name = cfg?.name ? game.i18n.localize(cfg.name) : key.slice(ns.length + 1);
  if (!name) name = key;
  return { nsTitle, name };
}

/** The report this world shares with the others (so the master can preview per-world changes). */
export async function sendReport() {
  if (!game.user.isGM) return;
  const report = {
    format: FORMAT,
    worldId: game.world.id,
    title: game.world.title,
    lastSeen: new Date().toISOString(),
    reportedBy: game.user.name,
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? null,
    appliedSnapshotId: game.settings.get(MODULE_ID, "appliedSnapshotId") || null,
    exclusions: localExclusions(),
    state: captureState()
  };
  await store.writeWorldReport(report);
  return report;
}

/** Save a full copy of this world's syncable state before changing it. */
export async function makeBackup(reason) {
  const state = captureState();
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const backup = { ...state, id, kind: "backup", createdAt: new Date().toISOString(), reason };
  const path = await store.writeBackup(game.world.id, backup);
  await game.settings.set(MODULE_ID, "lastBackup", path);
  return path;
}

/**
 * Apply the ticked items of a diff to this world, then tell everyone to reload.
 * Writes Setting documents directly so settings for modules that are only being
 * enabled now are stored too (they are picked up after the reload).
 */
export async function applyDiff(diff, selectedIds, { snapshotId = null, reason = "sync" } = {}) {
  const currentConfig = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration") ?? {});
  const writes = buildWrites(diff, selectedIds, currentConfig);
  if (writes.moduleConfig) writes.moduleConfig[MODULE_ID] = true; // never switch ourselves off
  if (writes.moduleConfig) writes.set["core.moduleConfiguration"] = JSON.stringify(writes.moduleConfig);

  const coll = worldSettingsCollection();
  const findDoc = key => coll.find(s => s.key === key && !s.user);
  const updates = [];
  const creates = [];
  const deletes = [];
  for (const [key, raw] of Object.entries(writes.set)) {
    const doc = findDoc(key);
    if (doc) updates.push({ _id: doc.id, value: raw });
    else creates.push({ key, value: raw });
  }
  for (const key of writes.reset) {
    const doc = findDoc(key);
    if (doc) deletes.push(doc.id);
  }

  const SettingCls = foundry.documents?.Setting?.implementation ?? CONFIG.Setting.documentClass;
  if (updates.length) await SettingCls.updateDocuments(updates);
  if (creates.length) await SettingCls.createDocuments(creates);
  if (deletes.length) await SettingCls.deleteDocuments(deletes);

  if (snapshotId) await game.settings.set(MODULE_ID, "appliedSnapshotId", snapshotId);
  try { await sendReport(); } catch (err) { console.warn(`${MODULE_ID} | report after apply failed`, err); }
  console.log(`${MODULE_ID} | applied (${reason}): ${updates.length} updated, ${creates.length} created, ${deletes.length} reset`);
  return { updated: updates.length, created: creates.length, reset: deletes.length };
}

export function reloadEveryone() {
  game.socket.emit(`module.${MODULE_ID}`, { action: "reload" });
  setTimeout(() => window.location.reload(), 750);
}
