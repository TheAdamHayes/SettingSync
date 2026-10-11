// The main "AH Setting Sync" window.
import { MODULE_ID, MODULE_TITLE, FORMAT, DEFAULT_EXCLUSIONS } from "./constants.js";
import { diffStates, countChanges, parsePatterns } from "./sync-core.js";
import { captureState, sendReport, settingLabel } from "./state.js";
import { renderDiff, reviewAndApply, wireDialog, esc } from "./dialogs.js";
import * as store from "./storage.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;

function fmtDate(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function diffForReport(masterState, report) {
  return diffStates(masterState, report.state ?? {}, {
    exclusions: report.exclusions ?? parsePatterns(DEFAULT_EXCLUSIONS),
    selfModuleId: MODULE_ID,
    localSystem: report.state?.source?.system
  });
}

async function showReadOnly(title, html, width = 820) {
  return DialogV2.prompt({
    window: { title, resizable: true },
    position: { width, height: 680 },
    classes: ["ahss-window"],
    content: `<div class="ahss-dialog ahss-scroll">${html}</div>`,
    ok: { label: "Close" },
    rejectClose: false
  });
}

export class SyncApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    classes: ["ahss-app"],
    window: { title: MODULE_TITLE, icon: "fa-solid fa-arrows-rotate", resizable: true },
    position: { width: 860, height: 760 },
    actions: {
      refresh: onRefresh,
      makeMaster: onMakeMaster,
      viewWorld: onViewWorld,
      viewState: onViewState,
      sinceLastPush: onSinceLastPush,
      push: onPush,
      reviewLatest: onReviewLatest,
      pullMaster: onPullMaster,
      report: onReport,
      saveExclusions: onSaveExclusions,
      resetExclusions: onResetExclusions,
      restoreBackup: onRestoreBackup
    }
  };

  /** Load everything the window shows from the shared folder. */
  async _prepareContext() {
    const ctx = { error: null };
    try {
      const [config, reports, backups] = await Promise.all([
        store.readConfig(), store.readWorldReports(), store.listBackups(game.world.id)
      ]);
      ctx.config = config;
      ctx.reports = reports;
      ctx.backups = backups.slice(0, 10);
    } catch (err) {
      console.error(err);
      ctx.error = err.message ?? String(err);
      ctx.config = {}; ctx.reports = {}; ctx.backups = [];
    }
    ctx.live = captureState();
    ctx.isMaster = ctx.config.masterWorldId === game.world.id;
    ctx.hasMaster = !!ctx.config.masterWorldId;
    this._ctx = ctx;
    return ctx;
  }

  async _renderHTML(ctx) {
    const { config, reports, isMaster, hasMaster, live } = ctx;
    const masterReport = reports[config.masterWorldId];
    const masterName = isMaster ? game.world.title : (masterReport?.title ?? config.masterWorldId);
    const latest = config.latestSnapshot;
    const applied = game.settings.get(MODULE_ID, "appliedSnapshotId");
    const h = [];

    if (ctx.error) h.push(`<div class="ahss-warnings"><p><i class="fa-solid fa-triangle-exclamation"></i> Could not read the shared sync files: ${esc(ctx.error)}</p></div>`);

    // ---- Status ----
    const roleBadge = isMaster ? `<span class="ahss-badge ahss-master">Master</span>`
      : hasMaster ? `<span class="ahss-badge ahss-follower">Follower</span>`
      : `<span class="ahss-badge">No master chosen yet</span>`;
    h.push(`<section class="ahss-card ahss-status">
      <div><span class="ahss-label">This world</span><strong>${esc(game.world.title)}</strong> ${roleBadge}</div>
      <div><span class="ahss-label">Master world</span><strong>${hasMaster ? esc(masterName) : "—"}</strong></div>
      <div><span class="ahss-label">Shared storage</span>${store.isForge() ? "Forge Assets Library" : "Foundry Data folder"}</div>
      <button type="button" data-action="refresh" class="ahss-small"><i class="fa-solid fa-rotate"></i> Refresh</button>
    </section>`);

    // ---- Master choice ----
    const worldOptions = new Map(Object.values(reports).map(r => [r.worldId, r.title]));
    worldOptions.set(game.world.id, game.world.title);
    h.push(`<section class="ahss-card">
      <h2><i class="fa-solid fa-crown"></i> Master world</h2>
      <p class="ahss-hint">The master is your template world. Its modules and settings are what gets pushed to the others.
      Worlds appear in this list once a GM has opened them with this module enabled.</p>
      <div class="ahss-row">
        <select name="masterWorld">
          ${[...worldOptions].map(([id, title]) => `<option value="${esc(id)}" ${id === config.masterWorldId ? "selected" : ""}>${esc(title)}${id === game.world.id ? " (this world)" : ""}</option>`).join("")}
        </select>
        <button type="button" data-action="makeMaster"><i class="fa-solid fa-crown"></i> Make this the master</button>
      </div>
    </section>`);

    // ---- Worlds table ----
    const others = Object.values(reports).sort((a, b) => a.title.localeCompare(b.title));
    h.push(`<section class="ahss-card"><h2><i class="fa-solid fa-earth-europe"></i> Worlds using ${MODULE_TITLE}</h2>`);
    if (!others.length) h.push(`<p class="ahss-none">No worlds have reported in yet.</p>`);
    else {
      h.push(`<table class="ahss-table"><thead><tr><th>World</th><th>Last opened</th><th>Latest push</th><th>${isMaster ? "Differences from this world" : ""}</th></tr></thead><tbody>`);
      for (const r of others) {
        const isM = r.worldId === config.masterWorldId;
        let pushCell = "—";
        if (isM) pushCell = `<span class="ahss-badge ahss-master">Master</span>`;
        else if (latest) {
          if (r.appliedSnapshotId === latest.id) pushCell = `<span class="ahss-good">Applied</span>`;
          else if (latest.targets?.includes(r.worldId)) pushCell = `<span class="ahss-pending">Waiting for GM to open</span>`;
          else pushCell = `<span class="ahss-muted">Not included</span>`;
        }
        let diffCell = "";
        if (isMaster && r.worldId !== game.world.id) {
          const n = countChanges(diffForReport(live, r));
          diffCell = n ? `<a data-action="viewWorld" data-world="${esc(r.worldId)}">${n} change(s) — view</a>` : `<span class="ahss-good">In sync</span>`;
        }
        h.push(`<tr><td><strong>${esc(r.title)}</strong>${r.worldId === game.world.id ? " <em>(this world)</em>" : ""}
          ${r.moduleVersion ? `<div class="ahss-muted">module v${esc(r.moduleVersion)}</div>` : ""}</td>
          <td>${esc(fmtDate(r.lastSeen))}</td><td>${pushCell}</td><td>${diffCell}</td></tr>`);
      }
      h.push(`</tbody></table>`);
      if (isMaster) h.push(`<p class="ahss-hint">Differences use each world's last report (taken whenever a GM opens that world).</p>`);
    }
    h.push(`</section>`);

    // ---- Master tools ----
    if (isMaster) {
      h.push(`<section class="ahss-card ahss-master-tools">
        <h2><i class="fa-solid fa-upload"></i> Push from this master</h2>
        <p class="ahss-hint">Only one world runs at a time, so a push is saved to the shared storage. Each chosen world shows the
        changes and asks a GM to confirm the next time it is opened.</p>
        <div class="ahss-row">
          <button type="button" data-action="viewState"><i class="fa-solid fa-magnifying-glass"></i> Load current state</button>
          ${latest && latest.sourceWorldId === game.world.id ? `<button type="button" data-action="sinceLastPush"><i class="fa-solid fa-code-compare"></i> What changed since last push</button>` : ""}
          <button type="button" data-action="push" class="ahss-primary"><i class="fa-solid fa-paper-plane"></i> Review &amp; push to worlds…</button>
        </div>
        ${latest ? `<p class="ahss-muted">Last push: ${esc(fmtDate(latest.createdAt))} to ${latest.targets?.length ?? 0} world(s)${latest.note ? ` — “${esc(latest.note)}”` : ""}</p>` : ""}
      </section>`);
    }

    // ---- Follower tools ----
    if (!isMaster && hasMaster) {
      const fromMaster = latest && latest.sourceWorldId === config.masterWorldId;
      let status = `<p class="ahss-none">The master hasn't pushed anything yet.</p>`;
      if (fromMaster) {
        const included = latest.targets?.includes(game.world.id);
        const done = applied === latest.id;
        status = `<p>Latest push: <strong>${esc(fmtDate(latest.createdAt))}</strong>${latest.note ? ` — “${esc(latest.note)}”` : ""}<br>
          ${done ? `<span class="ahss-good"><i class="fa-solid fa-circle-check"></i> Applied to this world</span>`
            : included ? `<span class="ahss-pending"><i class="fa-solid fa-clock"></i> Not applied here yet</span>`
            : `<span class="ahss-muted">This world was not included in that push (you can still apply it).</span>`}</p>`;
      }
      let pullInfo = `<p class="ahss-none">The master world hasn't reported in yet, so there is nothing to pull. Open the master world once.</p>`;
      if (masterReport?.state) {
        const n = countChanges(diffForReport(masterReport.state, { state: live, exclusions: parsePatterns(game.settings.get(MODULE_ID, "exclusions") ?? DEFAULT_EXCLUSIONS) }));
        pullInfo = `<p>The master's settings as of <strong>${esc(fmtDate(masterReport.lastSeen))}</strong>:
          ${n ? `<span class="ahss-pending">${n} difference(s) from this world</span>` : `<span class="ahss-good">this world already matches</span>`}</p>`;
      }
      h.push(`<section class="ahss-card">
        <h2><i class="fa-solid fa-download"></i> Updates from the master</h2>
        <h3 class="ahss-sub">Pushed by the master</h3>
        ${status}
        ${fromMaster ? `<div class="ahss-row"><button type="button" data-action="reviewLatest"><i class="fa-solid fa-list-check"></i> Review &amp; apply latest push…</button></div>` : ""}
        <h3 class="ahss-sub">Pull it yourself</h3>
        <p class="ahss-hint">Copy the master's current modules and settings into this world now, without waiting for a push.
        "Current" means the last time the master world was open (it reports itself whenever it's opened and whenever its settings change).</p>
        ${pullInfo}
        ${masterReport?.state ? `<div class="ahss-row"><button type="button" data-action="pullMaster" class="ahss-primary"><i class="fa-solid fa-cloud-arrow-down"></i> Pull master's current settings…</button></div>` : ""}
      </section>`);
    }

    // ---- This world: exclusions + backups ----
    const exclusions = game.settings.get(MODULE_ID, "exclusions") ?? DEFAULT_EXCLUSIONS;
    h.push(`<section class="ahss-card">
      <h2><i class="fa-solid fa-shield-halved"></i> This world: never overwrite</h2>
      <p class="ahss-hint">Settings matching these patterns are never changed in <strong>this</strong> world by a sync.
      One per line, <code>*</code> matches anything (e.g. <code>my-module.*</code> or <code>core.someSetting</code>).
      Users and player-specific settings are never synced, and neither are this module's own settings.</p>
      <textarea name="exclusions" rows="6" spellcheck="false">${esc(exclusions)}</textarea>
      <div class="ahss-row">
        <button type="button" data-action="saveExclusions"><i class="fa-solid fa-floppy-disk"></i> Save list</button>
        <button type="button" data-action="resetExclusions"><i class="fa-solid fa-arrow-rotate-left"></i> Restore defaults</button>
        <button type="button" data-action="report"><i class="fa-solid fa-tower-broadcast"></i> Report this world now</button>
      </div>
    </section>`);

    h.push(`<section class="ahss-card"><h2><i class="fa-solid fa-box-archive"></i> Backups of this world</h2>
      <p class="ahss-hint">Saved automatically before every sync. Restoring shows the changes first, like a push.</p>`);
    if (!ctx.backups.length) h.push(`<p class="ahss-none">No backups yet.</p>`);
    else h.push(`<ul class="ahss-backups">${ctx.backups.map(b => `<li><code>${esc(b.name.replace(/\.json$/, ""))}</code>
      <button type="button" class="ahss-small" data-action="restoreBackup" data-path="${esc(b.path)}"><i class="fa-solid fa-clock-rotate-left"></i> Restore…</button></li>`).join("")}</ul>`);
    h.push(`</section>`);

    return `<div class="ahss-body">${h.join("")}</div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }
}

// ---------------- Actions (`this` is the SyncApp) ----------------

async function onRefresh() {
  this.render();
}

async function onMakeMaster() {
  const select = this.element.querySelector('select[name="masterWorld"]');
  const id = select?.value;
  if (!id) return;
  const ctx = this._ctx;
  if (id === ctx.config.masterWorldId) return ui.notifications.info(`${MODULE_TITLE}: that world is already the master.`);
  const title = select.selectedOptions[0]?.textContent ?? id;
  const ok = await DialogV2.confirm({
    window: { title: "Change master world?" },
    content: `<div class="ahss-dialog"><p>Make <strong>${esc(title)}</strong> the master world for <em>all</em> worlds on this server?</p>
      <p>Only the master can push. Worlds will only offer pushes made by the master.</p></div>`,
    yes: { label: "Yes, make it the master" }, no: { label: "Cancel", default: true }, rejectClose: false
  });
  if (!ok) return;
  const config = await store.readConfig();
  config.format = FORMAT;
  config.masterWorldId = id;
  config.masterSetAt = new Date().toISOString();
  config.masterSetBy = `${game.user.name} in ${game.world.title}`;
  await store.writeConfig(config);
  ui.notifications.info(`${MODULE_TITLE}: master world set to ${title}.`);
  this.render();
}

async function onViewWorld(event, target) {
  const r = this._ctx.reports[target.dataset.world];
  if (!r) return;
  const diff = diffForReport(this._ctx.live, r);
  await showReadOnly(`Pushing to ${r.title} would change…`,
    `<p class="ahss-hint">Based on ${esc(r.title)}'s last report (${esc(fmtDate(r.lastSeen))}), including its own exclusion list.</p>${renderDiff(diff)}`);
}

async function onViewState() {
  const live = captureState();
  const mods = Object.entries(live.modules).filter(([, m]) => m.active).sort((a, b) => a[1].title.localeCompare(b[1].title));
  const keys = Object.keys(live.settings).sort();
  const groups = new Map();
  for (const k of keys) {
    const { nsTitle, name } = settingLabel(k);
    if (!groups.has(nsTitle)) groups.set(nsTitle, []);
    groups.get(nsTitle).push(`<li>${esc(name)} <code>${esc(k)}</code></li>`);
  }
  await showReadOnly(`Current state of ${game.world.title}`, `
    <p class="ahss-lead">This is what a push from this world would contain:
    <strong>${mods.length}</strong> enabled modules (of ${Object.keys(live.modules).length} installed) and
    <strong>${keys.length}</strong> world settings that differ from their defaults.</p>
    <details open><summary><strong>Enabled modules</strong></summary><ul class="ahss-list">${mods.map(([id, m]) => `<li>${esc(m.title)} <code>${esc(id)}</code></li>`).join("")}</ul></details>
    <details><summary><strong>Settings</strong></summary>${[...groups].map(([ns, items]) => `<h4>${esc(ns)}</h4><ul class="ahss-list">${items.join("")}</ul>`).join("")}</details>`);
}

async function onSinceLastPush() {
  const latest = this._ctx.config.latestSnapshot;
  try {
    const snap = await store.readSnapshot(latest.file);
    const diff = diffStates(captureState(), snap, { selfModuleId: MODULE_ID });
    await showReadOnly("Changed since the last push", `<p class="ahss-hint">"Now" is the last push (${esc(fmtDate(latest.createdAt))}), "After" is this world today.</p>${renderDiff(diff)}`);
  } catch (err) {
    ui.notifications.error(`${MODULE_TITLE}: could not read the last push (${err.message}).`);
  }
}

async function onPush() {
  await this.render(); // fresh reports
  const ctx = this._ctx;
  const live = ctx.live;
  const targets = Object.values(ctx.reports).filter(r => r.worldId !== game.world.id)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!targets.length) {
    return ui.notifications.warn(`${MODULE_TITLE}: no other worlds have reported in yet. Open each world once with the module enabled.`);
  }

  const rows = targets.map(r => {
    const diff = diffForReport(live, r);
    const n = countChanges(diff);
    return `<li class="ahss-target">
      <label><input type="checkbox" name="ahss-item" value="${esc(r.worldId)}" ${n ? "checked" : ""}>
        <strong>${esc(r.title)}</strong> — ${n ? `<span class="ahss-pending">${n} change(s)</span>` : `<span class="ahss-good">already in sync</span>`}
        <span class="ahss-muted">(last opened ${esc(fmtDate(r.lastSeen))})</span></label>
      ${n || diff.warnings.length ? `<details><summary>Show what will change in ${esc(r.title)}</summary>${renderDiff(diff)}</details>` : ""}
    </li>`;
  }).join("");

  const result = await DialogV2.wait({
    window: { title: "Push settings to worlds", resizable: true },
    position: { width: 900, height: 760 },
    classes: ["ahss-window"],
    content: `<div class="ahss-dialog ahss-scroll">
      <p class="ahss-lead">Push the modules and settings of <strong>${esc(game.world.title)}</strong> to the worlds ticked below.
      Expand a world to see exactly what will change there.</p>
      <section class="ahss-diff-section" data-group="targets"><header><h3>Worlds</h3>
        <span class="ahss-selectors"><a data-ahss-select="targets" data-on="1">All</a> · <a data-ahss-select="targets" data-on="0">None</a></span></header>
        <ul class="ahss-list">${rows}</ul></section>
      <label class="ahss-field">Note shown to the other worlds (optional)
        <input type="text" name="ahss-note" placeholder="e.g. Added Dice So Nice, changed initiative rules"></label>
      <p class="ahss-hint">Nothing changes straight away. Each world will show its list again and ask a GM to confirm when it is next opened,
      and a backup is taken there first. Users are never synced.</p>
      <label class="ahss-ack"><input type="checkbox" name="ahss-ack"> I have checked the changes for each ticked world.</label>
    </div>`,
    buttons: [
      { action: "push", label: "Push", icon: "fa-solid fa-paper-plane",
        callback: (event, button, dialog) => {
          const root = dialog?.element ?? button.form;
          return {
            ids: [...root.querySelectorAll('input[name="ahss-item"]:checked')].map(i => i.value),
            note: root.querySelector('input[name="ahss-note"]')?.value?.trim() ?? ""
          };
        } },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", default: true }
    ],
    render: (event, dialog) => wireDialog((dialog ?? event?.target)?.element, { unlockAction: "push" }),
    rejectClose: false
  });
  if (!result?.ids) return;
  if (!result.ids.length) return ui.notifications.info(`${MODULE_TITLE}: no worlds ticked, nothing pushed.`);

  const names = result.ids.map(id => ctx.reports[id]?.title ?? id);
  const sure = await DialogV2.confirm({
    window: { title: "Are you sure?" },
    content: `<div class="ahss-dialog"><p>Push this world's modules and settings to <strong>${names.length}</strong> world(s)?</p>
      <ul>${names.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
      <p>This replaces any earlier push that those worlds haven't applied yet.</p></div>`,
    yes: { label: "Yes, push", icon: "fa-solid fa-paper-plane" },
    no: { label: "No, go back", default: true }, rejectClose: false
  });
  if (!sure) return;

  try {
    const createdAt = new Date().toISOString();
    const id = `snap-${createdAt.replace(/[:.]/g, "-")}`;
    const snapshot = { ...captureState(), id, kind: "snapshot", createdAt, createdBy: game.user.name, note: result.note, targets: result.ids };
    const file = await store.writeSnapshot(snapshot);
    const config = await store.readConfig();
    const entry = { id, file, createdAt, note: result.note, targets: result.ids, sourceWorldId: game.world.id, sourceWorldTitle: game.world.title };
    config.format = FORMAT;
    config.latestSnapshot = entry;
    config.history = [entry, ...(config.history ?? [])].slice(0, 20);
    await store.writeConfig(config);
    await game.settings.set(MODULE_ID, "appliedSnapshotId", id);
    await sendReport();
    ui.notifications.info(`${MODULE_TITLE}: pushed to ${names.length} world(s). They'll be asked to apply it when next opened.`);
  } catch (err) {
    console.error(err);
    ui.notifications.error(`${MODULE_TITLE}: push failed — ${err.message}`);
  }
  this.render();
}

async function onReviewLatest() {
  const latest = this._ctx.config.latestSnapshot;
  if (!latest) return;
  try {
    const snap = await store.readSnapshot(latest.file);
    await reviewAndApply(snap, {
      title: `Apply push from ${latest.sourceWorldTitle ?? "master"}`,
      intro: latest.note ? `<p class="ahss-note-box"><strong>Note from the master:</strong> ${esc(latest.note)}</p>` : "",
      snapshotId: latest.id,
      reason: `push ${latest.id}`
    });
  } catch (err) {
    console.error(err);
    ui.notifications.error(`${MODULE_TITLE}: could not read the push (${err.message}).`);
  }
  this.render();
}

async function onPullMaster() {
  try {
    const [config, reports] = await Promise.all([store.readConfig(), store.readWorldReports()]);
    const masterId = config.masterWorldId;
    const report = reports[masterId];
    if (!masterId || masterId === game.world.id) return ui.notifications.warn(`${MODULE_TITLE}: this world is the master, there's nothing to pull.`);
    if (!report?.state) return ui.notifications.warn(`${MODULE_TITLE}: the master world hasn't reported in yet. Open it once first.`);
    // If the master's report is newer than its latest push, the pull already includes that push.
    const latest = config.latestSnapshot;
    const coversPush = latest && latest.sourceWorldId === masterId && new Date(report.lastSeen) >= new Date(latest.createdAt);
    await reviewAndApply(report.state, {
      title: `Pull from ${report.title}`,
      intro: `<p class="ahss-note-box">Pulling the current modules and settings of <strong>${esc(report.title)}</strong>
        (as of ${esc(fmtDate(report.lastSeen))}).</p>`,
      snapshotId: coversPush ? latest.id : null,
      reason: `pull from ${masterId}`
    });
  } catch (err) {
    console.error(err);
    ui.notifications.error(`${MODULE_TITLE}: could not pull from the master (${err.message}).`);
  }
  this.render();
}

async function onReport() {
  try { await sendReport(); ui.notifications.info(`${MODULE_TITLE}: this world's state was reported.`); }
  catch (err) { ui.notifications.error(`${MODULE_TITLE}: report failed — ${err.message}`); }
  this.render();
}

async function onSaveExclusions() {
  const text = this.element.querySelector('textarea[name="exclusions"]')?.value ?? "";
  await game.settings.set(MODULE_ID, "exclusions", text);
  try { await sendReport(); } catch { /* reported next time */ }
  ui.notifications.info(`${MODULE_TITLE}: exclusion list saved (${parsePatterns(text).length} pattern(s)).`);
  this.render();
}

async function onResetExclusions() {
  const ok = await DialogV2.confirm({
    window: { title: "Restore default list?" },
    content: `<p>Replace this world's exclusion list with the defaults?</p>`,
    rejectClose: false
  });
  if (!ok) return;
  await game.settings.set(MODULE_ID, "exclusions", DEFAULT_EXCLUSIONS);
  this.render();
}

async function onRestoreBackup(event, target) {
  try {
    const backup = await store.readSnapshot(target.dataset.path);
    await reviewAndApply(backup, {
      title: `Restore backup ${backup.id}`,
      intro: `<p class="ahss-note-box">Restoring the backup from <strong>${esc(fmtDate(backup.createdAt))}</strong>.
        This world's exclusion list still applies.</p>`,
      reason: `restore ${backup.id}`,
      applyLabel: "Restore ticked items"
    });
  } catch (err) {
    console.error(err);
    ui.notifications.error(`${MODULE_TITLE}: could not read that backup (${err.message}).`);
  }
}
