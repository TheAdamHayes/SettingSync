// "Here is what will change" + "Are you sure?" dialogs.
import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { countChanges, previewRaw, prettyRaw } from "./sync-core.js";
import { diffAgainstLocal, settingLabel, makeBackup, applyDiff, reloadEveryone } from "./state.js";

const DialogV2 = () => foundry.applications.api.DialogV2;

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ACTION_LABEL = {
  enable: "Enable", disable: "Disable",
  change: "Change", set: "Set (currently default)", reset: "Reset to default"
};

/** HTML list of a diff. selectable = show tick boxes (ticked by default). */
export function renderDiff(diff, { selectable = false } = {}) {
  const box = item => selectable
    ? `<input type="checkbox" name="ahss-item" value="${esc(item.id)}" checked>` : "";
  const parts = [];

  if (diff.warnings.length) {
    parts.push(`<div class="ahss-warnings">${diff.warnings.map(w =>
      `<p><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w.text)}</p>`).join("")}</div>`);
  }

  // Modules
  parts.push(`<section class="ahss-diff-section" data-group="modules">
    <header><h3><i class="fa-solid fa-puzzle-piece"></i> Modules (${diff.modules.length})</h3>
    ${selectable && diff.modules.length ? `<span class="ahss-selectors"><a data-ahss-select="modules" data-on="1">All</a> · <a data-ahss-select="modules" data-on="0">None</a></span>` : ""}
    </header>`);
  if (!diff.modules.length) parts.push(`<p class="ahss-none">No module changes.</p>`);
  else parts.push(`<ul class="ahss-list">${diff.modules.map(m => `<li>
      <label>${box(m)}
        <span class="ahss-tag ahss-${m.action}">${ACTION_LABEL[m.action]}</span>
        <strong>${esc(m.title)}</strong> <code>${esc(m.moduleId)}</code>
        ${m.versionNote ? `<em class="ahss-note">(${esc(m.versionNote)})</em>` : ""}
      </label></li>`).join("")}</ul>`);
  parts.push(`</section>`);

  // Settings grouped by namespace
  parts.push(`<section class="ahss-diff-section" data-group="settings">
    <header><h3><i class="fa-solid fa-sliders"></i> Settings (${diff.settings.length})</h3>
    ${selectable && diff.settings.length ? `<span class="ahss-selectors"><a data-ahss-select="settings" data-on="1">All</a> · <a data-ahss-select="settings" data-on="0">None</a></span>` : ""}
    </header>`);
  if (!diff.settings.length) parts.push(`<p class="ahss-none">No setting changes.</p>`);
  else {
    const groups = new Map();
    for (const s of diff.settings) {
      const label = settingLabel(s.key);
      if (!groups.has(label.nsTitle)) groups.set(label.nsTitle, []);
      groups.get(label.nsTitle).push({ ...s, label });
    }
    for (const [nsTitle, items] of groups) {
      parts.push(`<h4>${esc(nsTitle)} <span class="ahss-count">${items.length}</span></h4><ul class="ahss-list">`);
      for (const s of items) {
        parts.push(`<li><label>${box(s)}
          <span class="ahss-tag ahss-${s.action}">${ACTION_LABEL[s.action]}</span>
          <strong>${esc(s.label.name)}</strong> <code>${esc(s.key)}</code></label>
          <details><summary><span class="ahss-from">${esc(previewRaw(s.from, 50))}</span>
            <i class="fa-solid fa-arrow-right"></i>
            <span class="ahss-to">${esc(previewRaw(s.to, 50))}</span></summary>
            <div class="ahss-compare">
              <div><b>Now</b><pre>${esc(prettyRaw(s.from))}</pre></div>
              <div><b>After</b><pre>${esc(prettyRaw(s.to))}</pre></div>
            </div></details></li>`);
      }
      parts.push(`</ul>`);
    }
  }
  parts.push(`</section>`);

  if (diff.skipped.length) {
    parts.push(`<details class="ahss-skipped"><summary>Left unchanged (${diff.skipped.length})</summary><ul>${
      diff.skipped.map(s => `<li>${esc(s.text)}</li>`).join("")}</ul></details>`);
  }
  return parts.join("");
}

/** Wire up "All / None" links and an "I understand" tick box that unlocks a button. */
export function wireDialog(root, { ackName = "ahss-ack", unlockAction } = {}) {
  if (!root) return;
  root.querySelectorAll("[data-ahss-select]").forEach(a => a.addEventListener("click", ev => {
    ev.preventDefault();
    const group = a.dataset.ahssSelect;
    const on = a.dataset.on === "1";
    root.querySelectorAll(`[data-group="${group}"] input[name="ahss-item"]`).forEach(i => { i.checked = on; });
  }));
  const ack = root.querySelector(`input[name="${ackName}"]`);
  const btn = unlockAction ? root.querySelector(`button[data-action="${unlockAction}"]`) : null;
  if (ack && btn) {
    btn.disabled = true;
    ack.addEventListener("change", () => { btn.disabled = !ack.checked; });
  }
}

function dialogRoot(event, dialog) {
  return (dialog ?? event?.target)?.element ?? null;
}

/**
 * Full flow for receiving a state (a master snapshot or a backup):
 * preview with tick boxes -> "Are you sure?" -> backup -> apply -> reload.
 */
export async function reviewAndApply(masterState, { title, intro = "", snapshotId = null, reason = "sync", applyLabel = "Apply ticked changes", sourceExclusions = [] } = {}) {
  const diff = diffAgainstLocal(masterState, sourceExclusions);
  const total = countChanges(diff);

  if (!total) {
    await DialogV2().prompt({
      window: { title: title ?? MODULE_TITLE },
      position: { width: 560 },
      content: `<div class="ahss-dialog">${intro}<p class="ahss-ok"><i class="fa-solid fa-circle-check"></i> This world already matches. Nothing to change.</p>${renderDiff(diff)}</div>`,
      ok: { label: "OK" },
      rejectClose: false
    });
    if (snapshotId) await game.settings.set(MODULE_ID, "appliedSnapshotId", snapshotId);
    return false;
  }

  const content = `<div class="ahss-dialog ahss-scroll">
    ${intro}
    <p class="ahss-lead">These are the changes that will be made to <strong>${esc(game.world.title)}</strong>.
    Untick anything you want to keep as it is here. A backup of this world's current settings is saved first.</p>
    ${renderDiff(diff, { selectable: true })}
    <label class="ahss-ack"><input type="checkbox" name="ahss-ack"> I have read the list above and want to change this world.</label>
  </div>`;

  const selected = await DialogV2().wait({
    window: { title: title ?? `${MODULE_TITLE}: review changes`, resizable: true },
    position: { width: 880, height: 720 },
    classes: ["ahss-window"],
    content,
    buttons: [
      { action: "apply", label: applyLabel, icon: "fa-solid fa-check",
        callback: (event, button, dialog) => {
          const root = dialog?.element ?? button.form;
          return [...root.querySelectorAll('input[name="ahss-item"]:checked')].map(i => i.value);
        } },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", default: true }
    ],
    render: (event, dialog) => wireDialog(dialogRoot(event, dialog), { unlockAction: "apply" }),
    rejectClose: false
  });
  if (!Array.isArray(selected)) return false;
  if (!selected.length) { ui.notifications.info(`${MODULE_TITLE}: nothing was ticked, so nothing changed.`); return false; }

  const nMods = diff.modules.filter(m => selected.includes(m.id)).length;
  const nSet = diff.settings.filter(s => selected.includes(s.id)).length;
  const sure = await DialogV2().confirm({
    window: { title: "Are you sure?" },
    content: `<div class="ahss-dialog">
      <p>You are about to change <strong>${esc(game.world.title)}</strong>:</p>
      <ul><li><strong>${nMods}</strong> module(s) enabled/disabled</li>
          <li><strong>${nSet}</strong> setting(s) changed</li></ul>
      <p>A backup is saved first and can be restored from the sync menu.</p>
      <p class="ahss-warn"><i class="fa-solid fa-rotate"></i> The world will <strong>reload for everyone connected</strong> straight after.</p>
    </div>`,
    yes: { label: "Yes, change this world", icon: "fa-solid fa-check" },
    no: { label: "No, go back", icon: "fa-solid fa-xmark", default: true },
    rejectClose: false
  });
  if (!sure) return false;

  try {
    ui.notifications.info(`${MODULE_TITLE}: saving backup…`);
    await makeBackup(reason);
  } catch (err) {
    console.error(err);
    const goOn = await DialogV2().confirm({
      window: { title: "Backup failed" },
      content: `<p>The backup could not be saved (${esc(err.message)}).</p><p>Change the world anyway, without a backup?</p>`,
      yes: { label: "Continue without backup" }, no: { label: "Stop", default: true }, rejectClose: false
    });
    if (!goOn) return false;
  }
  const res = await applyDiff(diff, selected, { snapshotId, reason });
  ui.notifications.info(`${MODULE_TITLE}: done (${res.updated + res.created} set, ${res.reset} reset). Reloading…`);
  reloadEveryone();
  return true;
}
