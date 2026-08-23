const { Plugin, Notice, TFile, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  canvasPath: "TODO.canvas",
  archiveWeekday: 6, // 0=Sun ... 6=Sat
  lastArchivedAt: 0,
  statusField: "Status",
  modifiedAtField: "ModifiedAt",
  completedAtField: "CompletedAt",
  startedAtField: "StartedAt",
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

module.exports = class CanvasTaskSyncPlugin extends Plugin {
  async onload() {
    this.syncTimer = null;
    this.isSyncing = false;

    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    this.addSettingTab(new CanvasTaskSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.path !== this.settings.canvasPath) return;

        this.scheduleSync();
      })
    );

    // A task's StartedAt/Status changes on the note itself, not on the
    // canvas file, so the "modify" listener above (which only watches the
    // canvas) never fires for it. Refresh badges on the affected open
    // canvas leaves directly off the frontmatter-change event instead.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.hoverZoneObservers?.size) return;

        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!this.hasTaskTag(fm?.tags)) return;

        for (const leaf of this.hoverZoneObservers.keys()) {
          this.injectElapsedDaysBadges(leaf);
        }
      })
    );

    this.addCommand({
      id: "sync-task-canvas-now",
      name: "Sync task canvas now",
      callback: async () => {
        await this.syncTaskCanvas();
      },
    });

    this.addCommand({
      id: "archive-done-tasks",
      name: "Archive done tasks (remove from canvas)",
      callback: async () => {
        await this.archiveDoneTasks();
      },
    });

    this.addCommand({
      id: "create-task-canvas",
      name: "Create task canvas (Todo / Doing / Done template)",
      callback: async () => {
        await this.createTaskCanvas();
      },
    });

    if (this.settings.lastArchivedAt < this.getLastConfiguredWeekdayMidnight()) {
      await this.archiveDoneTasks(true);
    }

    this.registerInterval(
      window.setInterval(async () => {
        if (this.settings.lastArchivedAt < this.getLastConfiguredWeekdayMidnight()) {
          await this.archiveDoneTasks(true);
        }
      }, 1000 * 60 * 60)
    );

    this.setupHoverZoneObserver();

    new Notice("Canvas Task Sync loaded");
  }

  onunload() {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
    }
    if (this.hoverZoneObservers) {
      for (const observer of this.hoverZoneObservers.values()) {
        observer.disconnect();
      }
      this.hoverZoneObservers.clear();
    }
  }

  // Properties are hidden by default (see styles.css) and only revealed
  // while hovering a small marker injected into each canvas card's title.
  // Rather than watching the whole document (expensive — it would fire on
  // every DOM change anywhere in Obsidian, including unrelated note
  // editing), this only observes the container of each currently-open
  // Canvas pane, attaching/detaching observers as panes open and close.
  setupHoverZoneObserver() {
    this.hoverZoneObservers = new Map(); // WorkspaceLeaf -> MutationObserver

    const syncObservedLeaves = () => {
      // Only the configured target Canvas needs the hover-reveal feature —
      // other open Canvas panes (if any) are left completely untouched.
      const leaves = this.app.workspace
        .getLeavesOfType("canvas")
        .filter((leaf) => leaf.view?.file?.path === this.settings.canvasPath);
      const stillOpen = new Set(leaves);

      for (const [leaf, observer] of this.hoverZoneObservers) {
        if (!stillOpen.has(leaf)) {
          observer.disconnect();
          this.hoverZoneObservers.delete(leaf);
        }
      }

      for (const leaf of leaves) {
        if (this.hoverZoneObservers.has(leaf)) continue;

        const containerEl = leaf.view?.containerEl;
        if (!containerEl) continue;

        this.injectHoverZones(containerEl);
        this.injectElapsedDaysBadges(leaf);

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            // Also re-scan from mutation.target (the parent whose children
            // changed), not just mutation.addedNodes. If Obsidian rewrites a
            // label via `textContent = "..."`, the added node is a plain
            // Text node (not an HTMLElement) and would be silently skipped
            // below — the label itself, as the mutation target, is what
            // needs rescanning in that case.
            if (mutation.target instanceof HTMLElement) {
              this.injectHoverZones(mutation.target);
            }
            for (const node of mutation.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              this.injectHoverZones(node);
            }
          }

          // Cards re-render as they're added/moved, which would wipe out a
          // badge injected earlier — re-apply once per batch rather than
          // per-mutation (cheap: it only walks this canvas's own node list).
          // injectElapsedDaysBadges only touches textContent when the value
          // actually changes, so this does NOT retrigger the observer on
          // every pass — an earlier version wrote textContent unconditionally
          // here, which self-triggered the very same observer indefinitely
          // and froze the app. Keep that guard intact if this is ever touched.
          this.injectElapsedDaysBadges(leaf);
        });

        observer.observe(containerEl, { childList: true, subtree: true });
        this.hoverZoneObservers.set(leaf, observer);
      }
    };

    syncObservedLeaves();
    this.registerEvent(this.app.workspace.on("layout-change", syncObservedLeaves));
    this.registerEvent(this.app.workspace.on("active-leaf-change", syncObservedLeaves));
  }

  injectHoverZones(root) {
    // Search for .canvas-node-label directly (rather than .canvas-node and
    // then looking inside for a label). Entering edit mode on a card causes
    // Obsidian to recreate just the label element in place, and a mutation
    // reported for that swap surfaces the new label itself as the added
    // node — not a whole new .canvas-node — so matching on .canvas-node
    // alone missed it and the marker never got re-injected.
    const labels = root.matches?.(".canvas-node-label")
      ? [root]
      : Array.from(root.querySelectorAll?.(".canvas-node-label") ?? []);

    for (const label of labels) {
      // Marker already present on this exact label element (not a stale
      // one from before a recreation, since a recreated label starts empty).
      if (label.querySelector(".ctsync-hover-zone")) continue;

      const node = label.closest(".canvas-node");
      if (!node) continue;

      // Only file-nodes with an actual properties block get the marker —
      // group nodes (Todo/Doing/Done) also have a .canvas-node-label but no
      // .metadata-container.
      const hasProperties = node.querySelector(".metadata-container");
      if (!hasProperties) continue;

      // A small circled-i character placed right after the title, rather
      // than a separate dot floated in the corner — bigger/easier hover
      // target (padding in CSS) and self-explanatory as an "info" affordance.
      const zone = document.createElement("span");
      zone.className = "ctsync-hover-zone";
      zone.textContent = "ⓘ";
      zone.setAttribute("aria-label", "プロパティを表示（クリックで固定表示）");

      // The properties block is a real, editable widget (not a read-only
      // rendering) — a hover-only reveal would close the moment the cursor
      // moves toward it to actually click into a field. Click pins it open
      // so it can be used; clicking again un-pins and hides it.
      let pinned = false;

      // Obsidian renders the properties block in a collapsed state inside
      // canvas cards: .metadata-container has class "is-collapsed", and
      // the actual property rows live in a nested .metadata-content
      // element with an inline style="display: none" of its own. Both
      // .metadata-container and .metadata-content need to be forced open
      // (or restored to collapsed) together.
      const showProperties = () => {
        node.querySelectorAll(".metadata-container").forEach((el) => {
          el.style.setProperty("display", "block", "important");
          el.classList.remove("is-collapsed");
          el.querySelectorAll(".metadata-content").forEach((content) => {
            content.style.setProperty("display", "block", "important");
            content.classList.remove("is-collapsed");
          });
        });
      };

      const hideProperties = () => {
        node.querySelectorAll(".metadata-container").forEach((el) => {
          el.style.setProperty("display", "none", "important");
          el.classList.add("is-collapsed");
          el.querySelectorAll(".metadata-content").forEach((content) => {
            content.style.setProperty("display", "none", "important");
            content.classList.add("is-collapsed");
          });
        });
      };

      zone.addEventListener("mouseenter", () => {
        showProperties();
      });
      zone.addEventListener("mouseleave", () => {
        if (!pinned) hideProperties();
      });
      zone.addEventListener("click", (event) => {
        // Prevent the click from also selecting/focusing the underlying
        // canvas card.
        event.preventDefault();
        event.stopPropagation();

        pinned = !pinned;
        zone.classList.toggle("ctsync-pinned", pinned);

        if (pinned) {
          showProperties();
        } else {
          hideProperties();
        }
      });

      // Prepend rather than append: the label truncates long titles, so a
      // marker placed after the text can get clipped away. At the front it
      // stays at a fixed, always-visible position regardless of title length.
      label.prepend(zone);
    }
  }

  // Unlike the ⓘ marker (hover-only), the elapsed-days badge is always
  // visible — the whole point is spotting stale tasks at a glance without
  // having to hover every card.
  //
  // This walks the live Canvas view model (leaf.view.canvas.nodes) rather
  // than the DOM, since that's the only reliable way to map a rendered card
  // back to the vault file it represents. Like `.metadata-container` above,
  // `canvas.nodes`/`.nodeEl`/`.file` are undocumented Obsidian internals —
  // if this stops working after an update, re-inspect via DevTools.
  //
  // IMPORTANT: this is called from the same MutationObserver that watches
  // this DOM subtree (see setupHoverZoneObserver). Writing to `textContent`
  // unconditionally here previously caused an infinite loop — the write is
  // itself a childList mutation, even when the string value is unchanged,
  // so the observer kept re-firing and froze the app. The `badge.textContent
  // !== text` guard below is load-bearing; do not remove it.
  injectElapsedDaysBadges(leaf) {
    const canvas = leaf.view?.canvas;
    if (!canvas?.nodes) return;

    const { startedAtField } = this.settings;

    for (const node of canvas.nodes.values()) {
      if (!node.file || !node.nodeEl) continue;

      const label = node.nodeEl.querySelector(".canvas-node-label");
      if (!label) continue;

      const existing = label.querySelector(".ctsync-elapsed-badge");
      const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
      const days = this.elapsedDays(fm?.[startedAtField]);

      if (days === null) {
        existing?.remove();
        continue;
      }

      const text = `${days}d`;

      if (existing) {
        if (existing.textContent !== text) {
          existing.textContent = text;
        }
        continue;
      }

      const badge = document.createElement("span");
      badge.className = "ctsync-elapsed-badge";
      badge.textContent = text;
      label.prepend(badge);
    }
  }

  // Returns null (rather than 0) when there's no valid StartedAt, so callers
  // can distinguish "not started" from "started today" without a second check.
  elapsedDays(startedAt) {
    if (!startedAt) return null;

    const started = new Date(String(startedAt).replace(" ", "T"));
    if (Number.isNaN(started.getTime())) return null;

    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.max(0, Math.floor((Date.now() - started.getTime()) / msPerDay));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleSync() {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
    }

    this.syncTimer = window.setTimeout(async () => {
      await this.syncTaskCanvas();
    }, 1000);
  }

  // Approach A: a group's label IS the Status value, verbatim.
  // Any group on the configured canvas counts — no fixed vocabulary/whitelist.
  async syncTaskCanvas() {
    if (this.isSyncing) return;

    this.isSyncing = true;

    try {
      const canvasFile = this.app.vault.getAbstractFileByPath(this.settings.canvasPath);

      if (!(canvasFile instanceof TFile)) {
        new Notice(`Canvas not found: ${this.settings.canvasPath}`);
        return;
      }

      const raw = await this.app.vault.read(canvasFile);
      const canvas = JSON.parse(raw);
      const nodes = canvas.nodes ?? [];

      const groups = nodes.filter(
        (node) => node.type === "group" && node.label && node.label.trim() !== ""
      );

      const fileNodes = nodes.filter(
        (node) => node.type === "file" && node.file
      );

      let updated = 0;
      const placedPaths = new Set();

      for (const node of fileNodes) {
        const group = this.findContainingGroup(node, groups);

        if (!group) continue;

        const nextStatus = group.label;
        const notePath = this.normalizeMarkdownPath(node.file);
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);

        if (!(noteFile instanceof TFile)) {
          console.warn(`Note not found: ${notePath}`);
          continue;
        }

        placedPaths.add(noteFile.path);

        await this.app.fileManager.processFrontMatter(noteFile, (fm) => {
          if (!this.hasTaskTag(fm.tags)) return;

          const { statusField, modifiedAtField, completedAtField, startedAtField } = this.settings;
          const prevStatus = fm[statusField];
          const now = this.now();

          if (prevStatus !== nextStatus) {
            // StartedAt marks "left Backlog", not "created" or "added to
            // Backlog" — a task can sit in Backlog indefinitely without
            // inflating its elapsed-days count. It's set once on the first
            // move away from Backlog, left untouched while cycling between
            // other groups (e.g. Todo -> Doing -> Done), and cleared if the
            // task ever goes back to Backlog (see also revertOrphanedStatuses).
            const wasBacklog = !prevStatus || prevStatus === "Backlog";

            fm[statusField] = nextStatus;
            fm[modifiedAtField] = now;

            if (nextStatus === "Backlog") {
              delete fm[startedAtField];
            } else if (wasBacklog) {
              fm[startedAtField] = now;
            }

            if (nextStatus === "Done") {
              fm[completedAtField] = now;
            }

            updated++;
          }
        });
      }

      // Notes that claim an active (non-Backlog, non-Done) Status but are no
      // longer placed in any group on the canvas: revert to Backlog.
      // Removal from the Done group is handled separately by Archive and is
      // intentionally NOT reverted here.
      const reverted = await this.revertOrphanedStatuses(placedPaths);

      if (updated > 0 || reverted > 0) {
        new Notice(`Task Canvas synced: ${updated} updated, ${reverted} reverted to Backlog`);
      }
    } catch (error) {
      console.error("Task Canvas sync failed:", error);
      new Notice("Task Canvas sync failed. Check console.");
    } finally {
      this.isSyncing = false;
    }
  }

  async revertOrphanedStatuses(placedPaths) {
    let reverted = 0;

    const taskFiles = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && this.hasTaskTag(fm.tags);
    });

    const { statusField, modifiedAtField, startedAtField } = this.settings;

    for (const file of taskFiles) {
      if (placedPaths.has(file.path)) continue;

      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const status = fm?.[statusField];

      if (!status || status === "Backlog" || status === "Done") continue;

      await this.app.fileManager.processFrontMatter(file, (fm2) => {
        if (!this.hasTaskTag(fm2.tags)) return;
        if (!fm2[statusField] || fm2[statusField] === "Backlog" || fm2[statusField] === "Done") return;

        fm2[statusField] = "Backlog";
        fm2[modifiedAtField] = this.now();
        delete fm2[startedAtField];
      });

      reverted++;
    }

    return reverted;
  }

  async archiveDoneTasks(auto = false) {
    if (this.isSyncing) return;

    this.isSyncing = true;

    try {
      const canvasFile = this.app.vault.getAbstractFileByPath(this.settings.canvasPath);

      if (!(canvasFile instanceof TFile)) {
        new Notice(`Canvas not found: ${this.settings.canvasPath}`);
        return;
      }

      const raw = await this.app.vault.read(canvasFile);
      const canvas = JSON.parse(raw);
      const nodes = canvas.nodes ?? [];

      const doneGroups = nodes.filter(
        (node) => node.type === "group" && node.label === "Done"
      );

      const fileNodes = nodes.filter(
        (node) => node.type === "file" && node.file
      );

      const toRemove = new Set(
        fileNodes
          .filter((node) => this.findContainingGroup(node, doneGroups))
          .map((node) => node.id)
      );

      if (toRemove.size === 0) {
        await this.saveLastArchivedAt();
        if (!auto) new Notice("No done tasks to archive.");
        return;
      }

      canvas.nodes = nodes.filter((node) => !toRemove.has(node.id));
      await this.app.vault.modify(canvasFile, JSON.stringify(canvas, null, "\t"));
      await this.saveLastArchivedAt();

      new Notice(
        auto
          ? `Archive実行（自動）: ${toRemove.size}件`
          : `Archived ${toRemove.size} done task(s) from canvas.`
      );
    } catch (error) {
      console.error("Archive done tasks failed:", error);
      new Notice("Archive failed. Check console.");
    } finally {
      this.isSyncing = false;
    }
  }

  async createTaskCanvas() {
    const path = this.settings.canvasPath;
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing) {
      new Notice(`Canvas already exists: ${path}. Not overwriting.`);
      return;
    }

    // Group size is 2.5x the original (400x600 -> 1000x1500), gap scaled to match.
    const template = {
      nodes: [
        { id: "group-todo", type: "group", label: "Todo", x: 0, y: 0, width: 1000, height: 1500 },
        { id: "group-doing", type: "group", label: "Doing", x: 1125, y: 0, width: 1000, height: 1500 },
        { id: "group-done", type: "group", label: "Done", x: 2250, y: 0, width: 1000, height: 1500 },
      ],
      edges: [],
      metadata: { version: "1.0-1.0", frontmatter: {} },
    };

    await this.app.vault.create(path, JSON.stringify(template, null, "\t"));
    new Notice(`Created task canvas: ${path}`);
  }

  hasTaskTag(tags) {
    if (!tags) return false;

    if (Array.isArray(tags)) {
      return tags.includes("task") || tags.includes("#task");
    }

    if (typeof tags === "string") {
      return tags === "task" || tags === "#task";
    }

    return false;
  }

  findContainingGroup(node, groups) {
    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;

    return groups.find((group) => {
      return (
        centerX >= group.x &&
        centerX <= group.x + group.width &&
        centerY >= group.y &&
        centerY <= group.y + group.height
      );
    });
  }

  normalizeMarkdownPath(path) {
    return path.endsWith(".md") ? path : `${path}.md`;
  }

  async saveLastArchivedAt() {
    this.settings.lastArchivedAt = Date.now();
    await this.saveSettings();
  }

  // Generalizes the old hardcoded "last Saturday" check to any configured weekday.
  getLastConfiguredWeekdayMidnight() {
    const targetDay = this.settings.archiveWeekday;
    const now = new Date();
    const daysBack = (now.getDay() - targetDay + 7) % 7;
    const d = new Date(now);
    d.setDate(now.getDate() - daysBack);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  now() {
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
};

class CanvasTaskSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Canvas Task Sync" });

    new Setting(containerEl)
      .setName("対象Canvasパス")
      .setDesc("グループ名がそのままStatusになる、同期対象のCanvasファイルへのパス（Vaultルートからの相対パス）")
      .addText((text) =>
        text
          .setPlaceholder("TODO.canvas")
          .setValue(this.plugin.settings.canvasPath)
          .onChange(async (value) => {
            this.plugin.settings.canvasPath = value.trim() || DEFAULT_SETTINGS.canvasPath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive実行曜日")
      .setDesc("Doneグループのノードを週一で自動的にCanvasから取り除く曜日（ノートとStatusは維持されます）")
      .addDropdown((dropdown) => {
        WEEKDAY_LABELS.forEach((label, index) => {
          dropdown.addOption(String(index), `${label}曜日`);
        });
        dropdown.setValue(String(this.plugin.settings.archiveWeekday));
        dropdown.onChange(async (value) => {
          this.plugin.settings.archiveWeekday = Number(value);
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "フロントマターのフィールド名" });
    containerEl.createEl("p", {
      text:
        "変更は今後の同期から適用されます。既存ノートのフィールド名は自動では移行されません。" +
        "運用中に変更する場合は、VSCode等の外部エディタで一括置換してください。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Statusフィールド名")
      .setDesc("Canvas上のグループ名を書き込むフィールド名")
      .addText((text) =>
        text
          .setPlaceholder("Status")
          .setValue(this.plugin.settings.statusField)
          .onChange(async (value) => {
            this.plugin.settings.statusField = value.trim() || DEFAULT_SETTINGS.statusField;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ModifiedAtフィールド名")
      .setDesc("Status更新時に現在時刻を書き込むフィールド名")
      .addText((text) =>
        text
          .setPlaceholder("ModifiedAt")
          .setValue(this.plugin.settings.modifiedAtField)
          .onChange(async (value) => {
            this.plugin.settings.modifiedAtField = value.trim() || DEFAULT_SETTINGS.modifiedAtField;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("CompletedAtフィールド名")
      .setDesc("Doneグループに入った時刻を書き込むフィールド名")
      .addText((text) =>
        text
          .setPlaceholder("CompletedAt")
          .setValue(this.plugin.settings.completedAtField)
          .onChange(async (value) => {
            this.plugin.settings.completedAtField = value.trim() || DEFAULT_SETTINGS.completedAtField;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("StartedAtフィールド名")
      .setDesc("Backlogから最初に抜けた時刻を書き込むフィールド名（経過日数の起点。Backlogに戻るとクリアされます）")
      .addText((text) =>
        text
          .setPlaceholder("StartedAt")
          .setValue(this.plugin.settings.startedAtField)
          .onChange(async (value) => {
            this.plugin.settings.startedAtField = value.trim() || DEFAULT_SETTINGS.startedAtField;
            await this.plugin.saveSettings();
          })
      );
  }
}
