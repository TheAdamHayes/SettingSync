import { MODULE_ID, MODULE_TITLE, DEFAULT_EXCLUSIONS } from "./constants.js";
import { SyncApp } from "./sync-app.js";
import { sendReport } from "./state.js";
import { reviewAndApply, esc } from "./dialogs.js";
import * as store from "./storage.js";

let app = null;
function openApp() {
  if (!game.user.isGM) return ui.notifications.warn(`${MODULE_TITLE} is for GMs only.`);
  app ??= new SyncApp();
  app.render({ force: true });
  return app;
}

/** True for exactly one connected GM, so automatic work isn't done twice. */
function isLeadGM() {
  if (!game.user.isGM) return false;
  const active = game.users.activeGM;
  return !active || active.isSelf;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "exclusions", {
    scope: "world", config: false, type: String, default: DEFAULT_EXCLUSIONS
  });
  game.settings.register(MODULE_ID, "appliedSnapshotId", {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "dismissedSnapshotId", {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "lastBackup", {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "autoReport", {
    name: "Report this world automatically",
    hint: "When a GM opens this world (and when world settings change), share its current modules and settings so the master can preview changes. Recommended.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.registerMenu(MODULE_ID, "menu", {
    name: MODULE_TITLE,
    label: "Open Setting Sync",
    hint: "Choose the master world, push its modules and settings to other worlds, or review a push from the master.",
    icon: "fa-solid fa-arrows-rotate",
    type: SyncApp,
    restricted: true
  });

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { open: openApp, report: sendReport };
});

Hooks.once("ready", async () => {
  game.socket.on(`module.${MODULE_ID}`, data => {
    if (data?.action === "reload") {
      ui.notifications.info(`${MODULE_TITLE}: the GM synced this world's settings. Reloading…`);
      setTimeout(() => window.location.reload(), 500);
    }
  });

  if (!isLeadGM()) return;
  if (game.settings.get(MODULE_ID, "autoReport")) {
    try { await sendReport(); }
    catch (err) {
      console.error(`${MODULE_ID} | report failed`, err);
      ui.notifications.warn(`${MODULE_TITLE}: couldn't save this world's report to shared storage (${err.message}).`);
    }
  }
  try { await checkForPush(); }
  catch (err) { console.error(`${MODULE_ID} | checking for pushes failed`, err); }
});

// Keep the report fresh while the GM changes settings (waits 20s after the last change).
const debouncedReport = foundry.utils.debounce(() => {
  if (isLeadGM() && game.settings.get(MODULE_ID, "autoReport")) sendReport().catch(err => console.warn(`${MODULE_ID} |`, err));
}, 20000);
for (const hook of ["createSetting", "updateSetting", "deleteSetting"]) {
  Hooks.on(hook, doc => {
    if (doc?.user || doc?.key?.startsWith(`${MODULE_ID}.`)) return;
    debouncedReport();
  });
}

/** On a follower: if the master pushed something for this world, ask the GM about it. */
async function checkForPush() {
  const config = await store.readConfig();
  const latest = config.latestSnapshot;
  if (!latest || !config.masterWorldId) return;
  if (config.masterWorldId === game.world.id) return;
  if (latest.sourceWorldId !== config.masterWorldId) return;
  if (!latest.targets?.includes(game.world.id)) return;
  if (game.settings.get(MODULE_ID, "appliedSnapshotId") === latest.id) return;

  if (game.settings.get(MODULE_ID, "dismissedSnapshotId") === latest.id) {
    ui.notifications.info(`${MODULE_TITLE}: there's an unapplied push from the master. Open Setting Sync to review it.`);
    return;
  }

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: `${MODULE_TITLE}: new push from the master` },
    position: { width: 520 },
    content: `<div class="ahss-dialog">
      <p><strong>${esc(latest.sourceWorldTitle ?? "The master world")}</strong> pushed modules and settings for this world on
      <strong>${esc(new Date(latest.createdAt).toLocaleString())}</strong>.</p>
      ${latest.note ? `<p class="ahss-note-box">${esc(latest.note)}</p>` : ""}
      <p>Nothing changes until you review the list and confirm.</p></div>`,
    buttons: [
      { action: "review", label: "Review changes", icon: "fa-solid fa-list-check", default: true },
      { action: "later", label: "Remind me later", icon: "fa-solid fa-clock" },
      { action: "ignore", label: "Ignore this push", icon: "fa-solid fa-ban" }
    ],
    rejectClose: false
  });

  if (choice === "ignore") {
    await game.settings.set(MODULE_ID, "dismissedSnapshotId", latest.id);
    ui.notifications.info(`${MODULE_TITLE}: push ignored. You can still apply it from the Setting Sync menu.`);
    return;
  }
  if (choice !== "review") return;
  const snap = await store.readSnapshot(latest.file);
  await reviewAndApply(snap, {
    title: `Apply push from ${latest.sourceWorldTitle ?? "master"}`,
    intro: latest.note ? `<p class="ahss-note-box"><strong>Note from the master:</strong> ${esc(latest.note)}</p>` : "",
    snapshotId: latest.id,
    reason: `push ${latest.id}`,
    sourceExclusions: snap.masterExclusions ?? []
  });
}
