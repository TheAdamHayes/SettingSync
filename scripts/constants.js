// One id used everywhere: module.json "id", settings, socket, file folder.
export const MODULE_ID = "ah-setting-sync";
export const MODULE_TITLE = "AH Setting Sync";

// Version of the shared file format (bump only if the JSON layout changes).
export const FORMAT = 1;

// Folder in the shared data / Forge Assets Library that every world can see.
export const SHARED_FOLDER = MODULE_ID;
export const SUBFOLDERS = {
  worlds: `${SHARED_FOLDER}/worlds`,
  snapshots: `${SHARED_FOLDER}/snapshots`,
  backups: `${SHARED_FOLDER}/backups`
};
export const CONFIG_FILE = "config.json";

// Never synced, whatever the exclusion list says.
// - this module's own settings (each world keeps its own sync bookkeeping)
// - core.moduleConfiguration is handled separately as "Modules"
export const HARD_EXCLUSIONS = [`${MODULE_ID}.*`, "core.moduleConfiguration"];

// Editable default exclusions (per world). One glob pattern per line, * = anything.
export const DEFAULT_EXCLUSIONS = [
  "core.time",                    // in-game world time / calendar date
  "core.adventureImports",        // record of adventures imported into this world
  "core.compendiumConfiguration", // per-world compendium folders/ownership (world packs differ)
  "*migration*"                   // system/module migration markers - syncing these could skip data migrations
].join("\n");
