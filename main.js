const { Plugin, Notice, TFile, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  canvasPath: "Canvas Kanban Sync.canvas",
  archiveAutoEnabled: false,
  archiveWeekday: 6, // 0=Sun ... 6=Sat
  lastArchivedAt: 0,
  statusField: "Status",
  modifiedAtField: "ModifiedAt",
  completedAtField: "CompletedAt",
  startedAtField: "StartedAt",
  taskTag: "task",
  doneStatus: "Done",
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// Per-language content for createTutorialCanvas(). Layout/geometry/edges are
// shared (built once in createTutorialCanvas itself) — only strings live
// here, so adding a language later means adding one entry to this object,
// not duplicating the layout code. Japanese first (author's own language,
// and the settings tab is Japanese-only right now) — English is added back
// once the Japanese wording and the settings tab text are both finalized,
// as a translation pass rather than parallel maintenance of both.
const TUTORIAL_STRINGS = {
  ja: {
    folderName: "Canvas Kanban Sync チュートリアル",
    canvasFileName: "チュートリアル.canvas",
    task1Title: "①グループを移動するとStatusが変わる",
    task2Title: "②Vault内の既存ノートも追加できる",
    task3Title: "③完了カードはArchiveでまとめて片付けられる",
    task4Title: "④同期するかどうかはタグで設定できる",
    task5Title: "⑤プロパティはⓘマークをホバーすると見える",
    task6Title: "⑥経過日数はカード上のバッジで確認できる",
    task1Body:
      "Canvas Kanban Syncのチュートリアル用ノートです。\n\n" +
      "このカードを Doing や Done のグループへドラッグしてみてください。ドロップすると、このノートの " +
      "`Status` が自動的にそのグループ名（例: Doing）へ書き換わります。\n\n" +
      "自由に編集・削除して構いません。",
    task2Body: "Canvas Kanban Syncのチュートリアル用ノートです。②として、まだこのCanvasには配置していません。",
    task3Body: (doneStatus) =>
      `③ このカードは既に \`Status: ${doneStatus}\` になっています。「Archive done tasks」コマンドを実行す` +
      "ると、このカードだけCanvasから消えます。\n\n" +
      "・消えるのはCanvas上の配置だけで、ノート自体とStatusプロパティはそのまま残ります\n" +
      "・Archiveの対象グループ名は、設定画面の「Done扱いにするグループ」で変更できます\n" +
      "・曜日を指定して自動実行することもできます（設定画面の「Archive自動実行」トグル）。デフォルトはOFFで、" +
      "手動コマンドだけがいつでも使えます\n\n" +
      "実際に試したい場合は、コマンドパレットから実行してみてください。",
    task4Body: (taskTag) =>
      `④ このカードは実は同期されません。ノートのfrontmatterに \`tags: ${taskTag}\` が付いていないためです` +
      "（意図的な例です）。どのタグを対象にするかは、設定画面の「タスク判定タグ」で変更できます。",
    task5Body:
      "⑤ このカードのタイトル脇にある「ⓘ」マークにカーソルを合わせてみてください。普段は隠れている" +
      "Status等のプロパティが一時的に表示されます。クリックすると、固定表示⇔非表示を切り替えられます。",
    task6Body:
      "⑥ このカードのタイトル脇にある「◯d」のようなバッジは、`StartedAt`からの経過日数です。`StartedAt`は、" +
      "このノートを最初にCanvas上のいずれかのグループへドラッグ&ドロップして配置し、同期が実行されたタイミング" +
      "で記録されます。カードをCanvasから削除すると、次の同期でクリアされます。",
    welcome:
      "# 🗂️ Canvas Kanban Sync へようこそ\n\n" +
      "このCanvas上のグループ名（Todo / Doing / Done）が、そのままタスクノートの `Status` になります。" +
      "カードを別のグループへドラッグすると、ノートのfrontmatterが自動的に同期されます。\n\n" +
      "下の6枚のサンプルタスクを①→⑥の順に試してみてください。",
    // A separate, callout-styled node — folded into the welcome text as a
    // "##" subheading, this got skimmed past on the way to the groups below
    // (reported after actually using it). A distinct colored/iconed callout
    // block interrupts that eye path instead of blending into a wall of text.
    setupCallout: (canvasPath) =>
      "> [!warning] ⓪ さきに設定を変更してください\n" +
      "> このプラグインは常に1つのCanvasだけを同期対象にします。実際に手を動かして試すには、設定画面の" +
      "「対象Canvasパス」を次の値に変更してください。\n" +
      ">\n" +
      `> \`${canvasPath}\``,
    task2Hint: (task2Path) =>
      `② ファイルエクスプローラを開き、「${task2Path}」というノートを探してください。` +
      "このノートはまだCanvas上に配置していません。ドラッグ&ドロップでこのあたりに追加すると、①と同じように" +
      " `Status` が自動的に書き込まれます。",
    settingsOverview:
      "## ⚙️ 設定画面でカスタマイズできること\n\n" +
      "- **対象Canvasパス**: このCanvas以外のファイルを同期対象にしたい場合はここを変更します\n" +
      "- **Status / ModifiedAt / CompletedAt / StartedAt プロパティ名**: 自動で書き込まれるfrontmatterの" +
      "項目名を変更できます。Status以外は空欄にすると、その項目への書き込み自体をOFFにできます\n" +
      "- **StartedAt** をOFFにすると、Canvasカード上の経過日数バッジも表示されなくなります",
    noticeCreated: (path) => `チュートリアル用Canvasを作成しました: ${path}`,
    noticeExists: (path) => `チュートリアル用Canvasは既に存在します: ${path}（上書きしません）`,
  },
  // Settings-screen labels are referenced generically ("the settings
  // screen", paraphrased field names) rather than quoted, since the
  // settings screen itself is still Japanese-only as of this tutorial —
  // quoting an English label that doesn't exist yet would be actively
  // misleading. Revisit once the settings screen is translated (same
  // step ⑤ as this file, just not done yet).
  en: {
    folderName: "Canvas Kanban Sync Tutorial",
    canvasFileName: "Tutorial.canvas",
    task1Title: "① Moving between groups changes Status",
    task2Title: "② Existing vault notes can be added too",
    task3Title: "③ Completed cards can be tidied up with Archive",
    task4Title: "④ Whether a note syncs is controlled by its tag",
    task5Title: "⑤ Properties are revealed by hovering the ⓘ mark",
    task6Title: "⑥ Elapsed days are shown as a badge on the card",
    task1Body:
      "This is a Canvas Kanban Sync tutorial note.\n\n" +
      "Try dragging this card into the Doing or Done group. On drop, this note's `Status` is automatically " +
      "rewritten to match the group name (e.g. Doing).\n\n" +
      "Feel free to edit or delete it.",
    task2Body: "This is a Canvas Kanban Sync tutorial note. It's card ②, and hasn't been placed on this Canvas yet.",
    task3Body: (doneStatus) =>
      `③ This card already has \`Status: ${doneStatus}\`. Running the "Archive done tasks" command removes ` +
      "just this card from the Canvas.\n\n" +
      "- Only the card's placement on the Canvas is removed — the note itself and its Status property are left untouched\n" +
      "- Which group counts as \"done\" for Archive is configurable in the settings screen\n" +
      "- Archive can also run automatically on a chosen weekday (also in the settings screen). This is OFF by " +
      "default, so only the manual command runs unless you turn it on\n\n" +
      "If you'd like to try it for real, run it from the command palette.",
    task4Body: (taskTag) =>
      `④ This card never actually syncs — its note is missing \`tags: ${taskTag}\` in its frontmatter (this ` +
      "is deliberate). Which tag counts as a task is configurable in the settings screen.",
    task5Body:
      "⑤ Hover the “ⓘ” mark next to this card's title. Properties like Status, normally hidden, appear " +
      "temporarily. Click it to pin them open (or closed).",
    task6Body:
      "⑥ The badge next to this card's title, like “3d”, is the number of days elapsed since `StartedAt`. " +
      "`StartedAt` is recorded the first time this note is dragged into any group on a Canvas and synced. " +
      "Removing the card from the Canvas clears it on the next sync.",
    welcome:
      "# 🗂️ Welcome to Canvas Kanban Sync\n\n" +
      "The group a card sits in (Todo / Doing / Done) becomes that task note's `Status`. Drag a card into " +
      "another group and its frontmatter is synced automatically.\n\n" +
      "Try the six sample tasks below, in order from ① to ⑥.",
    setupCallout: (canvasPath) =>
      "> [!warning] ⓪ Change a setting first\n" +
      "> This plugin always syncs a single Canvas. To actually try things out, set \"Target Canvas path\" in " +
      "the settings screen to the following value.\n" +
      ">\n" +
      `> \`${canvasPath}\``,
    task2Hint: (task2Path) =>
      `② Open the file explorer and find the note "${task2Path}". It hasn't been placed on this Canvas yet — ` +
      "drag & drop it in around here, and its `Status` will be synced automatically, just like ①.",
    settingsOverview:
      "## ⚙️ What you can customize in the settings screen\n\n" +
      "- **Target Canvas path**: point the sync at a different Canvas file\n" +
      "- **Status / ModifiedAt / CompletedAt / StartedAt property names**: the frontmatter keys the plugin " +
      "writes. All except Status can be left blank to turn that property off entirely\n" +
      "- Turning off **StartedAt** also turns off the elapsed-days badge on Canvas cards",
    noticeCreated: (path) => `Created tutorial canvas: ${path}`,
    noticeExists: (path) => `Tutorial canvas already exists: ${path}. Not overwriting.`,
  },
};

module.exports = class CanvasKanbanSyncPlugin extends Plugin {
  async onload() {
    this.syncTimer = null;
    this.isSyncing = false;

    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    this.addSettingTab(new CanvasKanbanSyncSettingTab(this.app, this));

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

    this.addCommand({
      id: "create-tutorial-canvas-ja",
      name: "チュートリアル用Canvasを作成（日本語）",
      callback: async () => {
        await this.createTutorialCanvas("ja");
      },
    });

    this.addCommand({
      id: "create-tutorial-canvas-en",
      name: "Create tutorial canvas (English)",
      callback: async () => {
        await this.createTutorialCanvas("en");
      },
    });

    // archiveAutoEnabled only gates the automatic weekly trigger below —
    // the "Archive done tasks" command stays available either way, for
    // anyone who wants to archive on their own schedule instead of a fixed
    // weekday.
    if (this.settings.archiveAutoEnabled && this.settings.lastArchivedAt < this.getLastConfiguredWeekdayMidnight()) {
      await this.archiveDoneTasks(true);
    }

    this.registerInterval(
      window.setInterval(async () => {
        if (this.settings.archiveAutoEnabled && this.settings.lastArchivedAt < this.getLastConfiguredWeekdayMidnight()) {
          await this.archiveDoneTasks(true);
        }
      }, 1000 * 60 * 60)
    );

    this.setupHoverZoneObserver();

    new Notice("Canvas Kanban Sync loaded");
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

      // Run once immediately, rather than waiting for the user to touch the
      // marker. Without this, a freshly-detected card is only hidden by the
      // plain CSS rule (styles.css) — and Obsidian's own body-focus handler
      // (entering edit mode on the note body) force-opens the properties
      // block with its own inline style, which that plain CSS can't block.
      // Actually calling hideProperties() here writes the same is-collapsed
      // class + !important inline style onto this specific card that
      // Obsidian's focus handler itself checks/writes, so it no longer sees
      // a reason to force it open. (Confirmed: manually toggling the marker
      // once had the same effect — this just does it automatically.)
      hideProperties();

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
    // Badges are derived entirely from StartedAt — with the field disabled
    // (see the settings tab) there's no data to show, so skip walking the
    // canvas's nodes at all rather than silently finding nothing per-node.
    if (!startedAtField) return;

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
  // canvasPathOverride lets createTutorialCanvas() sync its own canvas
  // (which is intentionally NOT this.settings.canvasPath — see there) right
  // after creating it. Every other call site omits it and gets the normal,
  // user-configured target.
  async syncTaskCanvas(canvasPathOverride) {
    if (this.isSyncing) return;

    this.isSyncing = true;

    try {
      const targetPath = canvasPathOverride ?? this.settings.canvasPath;
      const canvasFile = this.app.vault.getAbstractFileByPath(targetPath);

      if (!(canvasFile instanceof TFile)) {
        new Notice(`Canvas not found: ${targetPath}`);
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

          const { statusField, modifiedAtField, completedAtField, startedAtField, doneStatus } = this.settings;
          const prevStatus = fm[statusField];
          const now = this.now();

          if (prevStatus !== nextStatus) {
            // StartedAt marks "left the resting state", not "created" —
            // a task can sit untouched indefinitely without inflating its
            // elapsed-days count. It's set once on the first move out of
            // resting, left untouched while cycling between other groups
            // (e.g. Todo -> Doing -> Done), and cleared if the task ever
            // goes back to resting (see also revertOrphanedStatuses).
            const wasBacklog = this.isBacklog(prevStatus);

            fm[statusField] = nextStatus;
            // ModifiedAt/CompletedAt/StartedAt are optional metadata, not
            // core to the plugin (unlike Status) — an empty field name
            // means the user has turned that field off, so skip writing it
            // rather than falling back to a default name (see settings tab).
            if (modifiedAtField) fm[modifiedAtField] = now;

            if (startedAtField) {
              if (nextStatus === "Backlog") {
                delete fm[startedAtField];
              } else if (wasBacklog) {
                fm[startedAtField] = now;
              }
            }

            if (completedAtField && nextStatus === doneStatus) {
              fm[completedAtField] = now;
            }

            updated++;
          }
        });
      }

      // Notes that claim an active (non-resting, non-Done) Status but are no
      // longer placed in any group on the canvas: revert to the resting
      // state (empty Status). Removal from the Done group is handled
      // separately by Archive and is intentionally NOT reverted here.
      const reverted = await this.revertOrphanedStatuses(placedPaths);

      if (updated > 0 || reverted > 0) {
        new Notice(`Task Canvas synced: ${updated} updated, ${reverted} reverted to resting`);
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

    const { statusField, modifiedAtField, startedAtField, doneStatus } = this.settings;

    for (const file of taskFiles) {
      if (placedPaths.has(file.path)) continue;

      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const status = fm?.[statusField];

      if (this.isBacklog(status) || status === doneStatus) continue;

      await this.app.fileManager.processFrontMatter(file, (fm2) => {
        if (!this.hasTaskTag(fm2.tags)) return;
        if (this.isBacklog(fm2[statusField]) || fm2[statusField] === doneStatus) return;

        // Resting state is "no Status" now, not the literal string
        // "Backlog" — see isBacklog(). Existing notes that still carry the
        // old literal value are left untouched here (isBacklog() already
        // treats them as resting, so they never reach this branch); they
        // only normalize to empty once something moves them again.
        delete fm2[statusField];
        if (modifiedAtField) fm2[modifiedAtField] = this.now();
        if (startedAtField) delete fm2[startedAtField];
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
        (node) => node.type === "group" && node.label === this.settings.doneStatus
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

  // Self-contained walkthrough in its own folder — deliberately NOT built
  // on this.settings.canvasPath, so it never touches (or requires) the
  // user's real board, and deleting the folder removes every trace of it.
  // Six seeded tasks + on-canvas text notes walk through the main behaviors
  // hands-on instead of requiring a README no one reads yet:
  //   ① already placed in Todo — drag it to see Status sync happen
  //   ② deliberately NOT placed — the user drags it in themselves
  //   ③ already placed in Done, already synced — ready to test Archive
  //   ④ deliberately untagged — placed but never syncs, a live counterexample
  //   ⑤ already placed/tagged — its own ⓘ marker demonstrates the hover reveal
  //   ⑥ already placed/tagged — its own elapsed-days badge is visible on it
  //
  // Layout/geometry/edges are language-agnostic and built once here; only
  // the strings come from TUTORIAL_STRINGS[lang] — adding a language later
  // means adding an entry there, not duplicating this method.
  async createTutorialCanvas(lang) {
    const s = TUTORIAL_STRINGS[lang];
    const { taskTag, doneStatus } = this.settings;

    const folderPath = s.folderName;
    const canvasPath = `${folderPath}/${s.canvasFileName}`;

    if (this.app.vault.getAbstractFileByPath(canvasPath)) {
      new Notice(s.noticeExists(canvasPath));
      return;
    }

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    // Create every auxiliary note BEFORE writing the canvas itself, so a
    // failure partway through never leaves a canvas pointing at notes that
    // don't exist. The canvas path collision check above already covers the
    // canvas side; getUniqueFilePath covers each note (relevant if a
    // previous attempt left notes behind but not the canvas).
    const task1Path = await this.getUniqueFilePath(`${folderPath}/${s.task1Title}.md`);
    await this.app.vault.create(task1Path, `---\ntags:\n  - ${taskTag}\n---\n\n${s.task1Body}\n`);

    const task2Path = await this.getUniqueFilePath(`${folderPath}/${s.task2Title}.md`);
    await this.app.vault.create(task2Path, `---\ntags:\n  - ${taskTag}\n---\n\n${s.task2Body}\n`);

    const task3Path = await this.getUniqueFilePath(`${folderPath}/${s.task3Title}.md`);
    await this.app.vault.create(task3Path, `---\ntags:\n  - ${taskTag}\n---\n\n${s.task3Body(doneStatus)}\n`);

    // No tags field at all — deliberately not recognized as a task note,
    // even though it's about to be placed in a group like ① and ③ are.
    const task4Path = await this.getUniqueFilePath(`${folderPath}/${s.task4Title}.md`);
    await this.app.vault.create(task4Path, `${s.task4Body(taskTag)}\n`);

    // ⑤⑥ are tagged and placed like ①③, so the initial sync below gives
    // them a real Status/StartedAt — the hover-properties marker and the
    // elapsed-days badge they each explain are then genuinely visible on
    // their own card, not just described in the abstract.
    const task5Path = await this.getUniqueFilePath(`${folderPath}/${s.task5Title}.md`);
    await this.app.vault.create(task5Path, `---\ntags:\n  - ${taskTag}\n---\n\n${s.task5Body}\n`);

    const task6Path = await this.getUniqueFilePath(`${folderPath}/${s.task6Title}.md`);
    await this.app.vault.create(task6Path, `---\ntags:\n  - ${taskTag}\n---\n\n${s.task6Body}\n`);

    const groups = [
      { id: "group-todo", type: "group", label: "Todo", x: 0, y: 0, width: 1000, height: 1500 },
      { id: "group-doing", type: "group", label: "Doing", x: 1125, y: 0, width: 1000, height: 1500 },
      { id: "group-done", type: "group", label: "Done", x: 2250, y: 0, width: 1000, height: 1500 },
    ];

    // dynamicHeight lets Obsidian grow each card to fit its actual note
    // content instead of a hand-picked fixed height that inevitably clips
    // longer bodies (see ③) — the numbers below are just a reasonable
    // starting size, not the final rendered height.
    const cards = [
      { id: "task-1", type: "file", file: task1Path, x: 60, y: 120, width: 400, height: 340, dynamicHeight: true },
      { id: "task-3", type: "file", file: task3Path, x: 2310, y: 120, width: 400, height: 560, dynamicHeight: true },
      // Colored to hint "this one behaves differently" before reading any text.
      {
        id: "task-4",
        type: "file",
        file: task4Path,
        x: 60,
        y: 820,
        width: 400,
        height: 340,
        dynamicHeight: true,
        color: "1",
      },
      { id: "task-5", type: "file", file: task5Path, x: 1185, y: 120, width: 400, height: 320, dynamicHeight: true },
      { id: "task-6", type: "file", file: task6Path, x: 1185, y: 500, width: 400, height: 320, dynamicHeight: true },
    ];

    const texts = [
      { id: "welcome", type: "text", x: 0, y: -460, width: 3250, height: 180, text: s.welcome },
      { id: "setup-callout", type: "text", x: 0, y: -260, width: 3250, height: 180, text: s.setupCallout(canvasPath) },
      { id: "task-2-hint", type: "text", x: 60, y: 480, width: 880, height: 260, text: s.task2Hint(task2Path) },
      {
        id: "settings-overview",
        type: "text",
        x: 0,
        y: 1600,
        width: 2250,
        height: 380,
        text: s.settingsOverview,
      },
    ];

    const edges = [];

    const template = {
      nodes: [...groups, ...cards, ...texts],
      edges,
      metadata: { version: "1.0-1.0", frontmatter: {} },
    };

    await this.app.vault.create(canvasPath, JSON.stringify(template, null, "\t"));
    new Notice(s.noticeCreated(canvasPath));

    // Populate Status/StartedAt for ①③⑤⑥ immediately (④ stays untouched
    // since it's untagged, ② isn't placed at all), so opening the new canvas
    // already shows the sync working rather than inert cards. Passed
    // explicitly since the tutorial canvas is deliberately not
    // this.settings.canvasPath (see method comment above).
    await this.syncTaskCanvas(canvasPath);
  }

  // Obsidian's vault.create() throws on an existing path rather than
  // disambiguating for you (unlike the in-app "new note" UI, which appends
  // "1", "2", ...). Needed here because, unlike the canvas path itself
  // (checked further up, and left to abort the whole command on collision),
  // silently failing to create the sample task would leave a canvas
  // pointing at a file that was never written.
  async getUniqueFilePath(basePath) {
    if (!this.app.vault.getAbstractFileByPath(basePath)) return basePath;

    const dotIndex = basePath.lastIndexOf(".");
    const stem = dotIndex === -1 ? basePath : basePath.slice(0, dotIndex);
    const ext = dotIndex === -1 ? "" : basePath.slice(dotIndex);

    let n = 1;
    let candidate = `${stem} ${n}${ext}`;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      n++;
      candidate = `${stem} ${n}${ext}`;
    }
    return candidate;
  }

  // The resting state ("not on the board") is represented by an empty/absent
  // Status, not a literal string — see the 2026-09-03 decision to stop
  // writing "Backlog" (kept configurable-string treatment for Done, since
  // that mirrors an actual user-named Canvas group; the resting state isn't
  // tied to any group at all). "Backlog" is still recognized here so notes
  // written before this change keep working — revertOrphanedStatuses only
  // ever WRITES empty now, this is read-side backward compatibility only.
  isBacklog(status) {
    return !status || status === "Backlog";
  }

  hasTaskTag(tags) {
    if (!tags) return false;

    const taskTag = this.settings.taskTag;

    if (Array.isArray(tags)) {
      return tags.includes(taskTag) || tags.includes(`#${taskTag}`);
    }

    if (typeof tags === "string") {
      return tags === taskTag || tags === `#${taskTag}`;
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

class CanvasKanbanSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Canvas Kanban Sync" });
    containerEl.createEl("p", {
      text:
        "Obsidian CanvasのグループをKanbanボードの列として使い、カードを別グループへ動かすとノートのStatus" +
        "プロパティが自動的に同期されます。グループ名がそのままStatus値になるので、列の名前や数は自由に変更" +
        "できます。以下では、対象Canvasや同期の細かい挙動を設定できます。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("対象Canvasパス")
      .setDesc("対象のCanvasファイルへのパス（Vaultルートからの相対パス）")
      .addText((text) =>
        text
          .setPlaceholder("Canvas Kanban Sync.canvas")
          .setValue(this.plugin.settings.canvasPath)
          .onChange(async (value) => {
            this.plugin.settings.canvasPath = value.trim() || DEFAULT_SETTINGS.canvasPath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("タスク判定タグ")
      .setDesc("frontmatterのtagsにこのタグが含まれるノートだけを同期対象にする（#は付けずに入力）")
      .addText((text) =>
        text
          .setPlaceholder("task")
          .setValue(this.plugin.settings.taskTag)
          .onChange(async (value) => {
            this.plugin.settings.taskTag = value.trim() || DEFAULT_SETTINGS.taskTag;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Done扱いにするグループ")
      .setDesc("このCanvasグループ名を「完了」として扱う。Archiveコマンドの対象・CompletedAt記録の判定対象")
      .addText((text) =>
        text
          .setPlaceholder("Done")
          .setValue(this.plugin.settings.doneStatus)
          .onChange(async (value) => {
            this.plugin.settings.doneStatus = value.trim() || DEFAULT_SETTINGS.doneStatus;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive自動実行")
      .setDesc(
        "週一で自動的にDone扱いのグループのノードをCanvasから取り除く機能のOn/Off。" +
          "OFFにしても、コマンド「Archive done tasks」による手動実行は可能"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.archiveAutoEnabled).onChange(async (value) => {
          this.plugin.settings.archiveAutoEnabled = value;
          await this.plugin.saveSettings();
          this.display(); // re-render to show/hide the weekday picker below
        })
      );

    if (this.plugin.settings.archiveAutoEnabled) {
      new Setting(containerEl)
        .setName("Archive実行曜日")
        .setDesc("Done扱いのグループのノードを週一で自動的にCanvasから取り除く曜日（ノートとStatusは維持）")
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

    containerEl.createEl("h3", { text: "同期に使うプロパティ名" });
    containerEl.createEl("p", {
      text:
        "変更は今後の同期から適用されます。既存ノートのプロパティ名は自動では移行されません。" +
        "運用中に変更する場合は、VSCode等の外部エディタで一括置換してください。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Statusとして使うプロパティ")
      .setDesc("Canvas上のグループ名を書き込むプロパティ名")
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
      .setName("StartedAtとして使うプロパティ")
      .setDesc(
        "休止状態（Statusが未設定）から最初に抜けた時刻を書き込むプロパティ名（経過日数の起点。休止状態に戻るとクリアされます）。" +
          "空欄にするとこのプロパティへの書き込みと、Canvasカード上の経過日数バッジ表示の両方をOFFにできます"
      )
      .addText((text) =>
        text
          .setPlaceholder("StartedAt")
          .setValue(this.plugin.settings.startedAtField)
          .onChange(async (value) => {
            this.plugin.settings.startedAtField = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ModifiedAtとして使うプロパティ")
      .setDesc("Status更新時に現在時刻を書き込むプロパティ名。空欄にするとこのプロパティへの書き込みをOFFにできます")
      .addText((text) =>
        text
          .setPlaceholder("ModifiedAt")
          .setValue(this.plugin.settings.modifiedAtField)
          .onChange(async (value) => {
            this.plugin.settings.modifiedAtField = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("CompletedAtとして使うプロパティ")
      .setDesc("Doneグループに入った時刻を書き込むプロパティ名。空欄にするとこのプロパティへの書き込みをOFFにできます")
      .addText((text) =>
        text
          .setPlaceholder("CompletedAt")
          .setValue(this.plugin.settings.completedAtField)
          .onChange(async (value) => {
            this.plugin.settings.completedAtField = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
