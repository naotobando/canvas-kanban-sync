const { Plugin, Notice, TFile, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  canvasPath: "TODO.canvas",
  archiveWeekday: 6, // 0=Sun ... 6=Sat
  lastArchivedAt: 0,
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

    new Notice("Canvas Task Sync loaded");
  }

  onunload() {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
    }
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

          const prevStatus = fm.Status;
          const now = this.now();

          if (prevStatus !== nextStatus) {
            fm.Status = nextStatus;
            fm.ModifiedAt = now;

            if (nextStatus === "Done") {
              fm.CompletedAt = now;
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

    for (const file of taskFiles) {
      if (placedPaths.has(file.path)) continue;

      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const status = fm?.Status;

      if (!status || status === "Backlog" || status === "Done") continue;

      await this.app.fileManager.processFrontMatter(file, (fm2) => {
        if (!this.hasTaskTag(fm2.tags)) return;
        if (!fm2.Status || fm2.Status === "Backlog" || fm2.Status === "Done") return;

        fm2.Status = "Backlog";
        fm2.ModifiedAt = this.now();
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

    const template = {
      nodes: [
        { id: "group-todo", type: "group", label: "Todo", x: 0, y: 0, width: 400, height: 600 },
        { id: "group-doing", type: "group", label: "Doing", x: 450, y: 0, width: 400, height: 600 },
        { id: "group-done", type: "group", label: "Done", x: 900, y: 0, width: 400, height: 600 },
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
  }
}
