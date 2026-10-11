// Pure logic: no Foundry globals here, so it can be tested in Node.
import { HARD_EXCLUSIONS } from "./constants.js";

/** JSON.stringify with sorted object keys, so key order never causes a fake difference. */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Settings are stored as raw JSON strings. Normalise one for comparison. */
export function normalizeRaw(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return stableStringify(raw);
  try { return stableStringify(JSON.parse(raw)); } catch { return raw; }
}

/** Turn the exclusion text (one pattern per line, # comments allowed) into a list. */
export function parsePatterns(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

const regexCache = new Map();
function globToRegex(pattern) {
  if (!regexCache.has(pattern)) {
    const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    regexCache.set(pattern, new RegExp(`^${esc}$`, "i"));
  }
  return regexCache.get(pattern);
}

export function matchesAny(key, patterns) {
  return patterns.some(p => globToRegex(p).test(key));
}

export function isExcluded(key, patterns = []) {
  return matchesAny(key, HARD_EXCLUSIONS) || matchesAny(key, patterns);
}

/**
 * Work out what applying `master` to `local` would change.
 * Both are states: { modules: {id: {title, version, active}}, settings: {key: rawJson} }
 * options.exclusions: glob patterns that the receiving world refuses
 * options.selfModuleId: this module's id (never disabled)
 * options.localSystem / master.source.system: used for warnings
 */
export function diffStates(master, local, options = {}) {
  const exclusions = options.exclusions ?? [];
  const selfId = options.selfModuleId;
  const result = { modules: [], settings: [], skipped: [], warnings: [] };

  // ---- Modules ----
  const mMods = master.modules ?? {};
  const lMods = local.modules ?? {};
  for (const id of new Set([...Object.keys(mMods), ...Object.keys(lMods)])) {
    const m = mMods[id];
    const l = lMods[id];
    const title = m?.title ?? l?.title ?? id;
    if (id === selfId) continue;
    if (m && !l) {
      if (m.active) result.warnings.push({
        type: "module-missing", id, title,
        text: `"${title}" is enabled on the master but is not installed here, so it can't be enabled.`
      });
      continue;
    }
    if (!m && l) {
      if (l.active) result.skipped.push({
        type: "module-unknown", id, title,
        text: `"${title}" is not installed on the master, so it is left as it is here.`
      });
      continue;
    }
    if (!!m.active !== !!l.active) {
      result.modules.push({
        id: `module:${id}`, moduleId: id, title,
        action: m.active ? "enable" : "disable",
        from: !!l.active, to: !!m.active,
        versionNote: (m.version && l.version && m.version !== l.version)
          ? `master has v${m.version}, this world has v${l.version}` : null
      });
    }
  }

  // ---- Settings ----
  const mSet = master.settings ?? {};
  const lSet = local.settings ?? {};
  for (const key of [...new Set([...Object.keys(mSet), ...Object.keys(lSet)])].sort()) {
    const hard = matchesAny(key, HARD_EXCLUSIONS);
    if (hard) continue;
    const mRaw = mSet[key];
    const lRaw = lSet[key];
    const inM = mRaw !== undefined;
    const inL = lRaw !== undefined;
    if (inM && inL && normalizeRaw(mRaw) === normalizeRaw(lRaw)) continue;
    const entry = {
      id: `setting:${key}`, key, namespace: key.split(".")[0],
      action: inM && inL ? "change" : (inM ? "set" : "reset"),
      from: inL ? lRaw : null,
      to: inM ? mRaw : null
    };
    if (matchesAny(key, exclusions)) result.skipped.push({ ...entry, type: "setting-excluded",
      text: `${key} differs but is on this world's exclusion list.` });
    else result.settings.push(entry);
  }

  // ---- General warnings ----
  const mSys = master.source?.system;
  const lSys = options.localSystem;
  if (mSys && lSys && mSys.id !== lSys.id) result.warnings.push({
    type: "system", text: `The master uses the "${mSys.id}" system but this world uses "${lSys.id}". Syncing is not recommended.`
  });
  else if (mSys && lSys && mSys.version !== lSys.version) result.warnings.push({
    type: "system-version", text: `System version differs (master ${mSys.version}, here ${lSys.version}).`
  });
  return result;
}

export function countChanges(diff) {
  return diff.modules.length + diff.settings.length;
}

/**
 * From a diff and the list of ticked item ids, build the raw writes for this world.
 * currentModuleConfig: the current core.moduleConfiguration object of this world.
 * Returns { moduleConfig|null, set: {key: raw}, reset: [key] }
 */
export function buildWrites(diff, selectedIds, currentModuleConfig = {}) {
  const chosen = new Set(selectedIds);
  const out = { moduleConfig: null, set: {}, reset: [] };
  const mods = diff.modules.filter(m => chosen.has(m.id));
  if (mods.length) {
    out.moduleConfig = { ...currentModuleConfig };
    for (const m of mods) out.moduleConfig[m.moduleId] = m.to;
  }
  for (const s of diff.settings) {
    if (!chosen.has(s.id)) continue;
    if (s.action === "reset") out.reset.push(s.key);
    else out.set[s.key] = s.to;
  }
  return out;
}

/** Short one-line preview of a raw JSON value for display. */
export function previewRaw(raw, max = 80) {
  if (raw === null || raw === undefined) return "(default)";
  let text;
  try { text = JSON.stringify(JSON.parse(raw)); } catch { text = String(raw); }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pretty multi-line version for the expandable view. */
export function prettyRaw(raw) {
  if (raw === null || raw === undefined) return "(default value)";
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}
