# AH Setting Sync

Keep several worlds on the same Foundry server (e.g. one Forge game with multiple worlds) in line with a
**master** (template) world: which modules are enabled, module settings, and game settings.

**Users are never synced.** User accounts are never read or written, and player-specific
(user-scoped) settings are skipped.

## How it works

Only one world runs at a time, so worlds can't talk to each other live. Instead they share a folder,
`ah-setting-sync/`, in your Forge Assets Library (or the Foundry Data folder when self-hosted).

1. **Each world reports in.** When a GM opens a world with this module enabled, it saves a report of its
   modules and settings to the shared folder. Open every world once after installing.
2. **Pick the master.** Game Settings → Configure Settings → AH Setting Sync → *Open Setting Sync*. Choose your
   template world in the dropdown and click *Make this the master*.
3. **Push from the master.** In the master world: *Load current state* shows what would be pushed;
   *Review & push to worlds…* lists every other world with exactly what will change there. Tick the worlds,
   tick "I have checked", click Push, confirm.
4. **Apply in each world.** Next time a GM opens a pushed-to world, it pops up: *Review changes* shows the list
   (with tick boxes, so you can leave things out), then asks *Are you sure?*, saves a backup, applies, and
   reloads everyone connected.

## Safety

- Two confirmations before anything changes, with a full before/after list.
- An automatic backup before every sync; restore from the *Backups* section (also previewed first).
- Per-world **never overwrite** list (glob patterns). Defaults: world time, adventure imports,
  compendium configuration and any `*migration*` setting.
- This module's own settings and the module on/off list are handled separately and never clobbered.
- Modules that aren't installed on a world are reported, not forced.

## Macro

```js
game.modules.get("ah-setting-sync").api.open();
```
