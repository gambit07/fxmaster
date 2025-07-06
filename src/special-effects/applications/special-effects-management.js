import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";

export class SpecialEffectsManagement extends FXMasterBaseFormV2 {
  constructor(options = {}) {
    super(options);
    SpecialEffectsManagement.instance = this;

    this.searchFilter = new CONFIG.fxmaster.SearchFilterNS({
      inputSelector: "input[data-search]",
      contentSelector: ".specials-list",
      callback: this._onSearchFilter.bind(this),
    });

    this.batchSize = 500;
    this.renderedCount = 0;
    this.fullEffects = [];
    this.visibleEffects = [];
    this.currentTag = "";
    this.searchMode = false;
    this.sentinel = null;
    this.observer = null;
    this.currentTag = "";
  }

  static DEFAULT_OPTIONS = {
    id: "specials-config",
    tag: "section",
    classes: ["fxmaster", "specials-management", "form-v2"],
    dragDrop: [{ dragSelector: ".special-effects", dropSelector: null }],
    window: { title: "FXMASTER.SpecialEffectsManagementTitle", resizable: true },
    position: { width: 500, height: 500 },
    actions: {
      filterTag: SpecialEffectsManagement.updateTagFilter,
      editEffect: SpecialEffectsManagement.editEffect,
    },
  };

  static PARTS = [{ template: "modules/fxmaster/templates/special-effects-management.hbs" }];

  async _prepareContext() {
    const buckets = CONFIG.fxmaster.userSpecials;

    if (!buckets || Object.keys(buckets).length === 0) {
      ui.notifications.error(game.i18n.localize("FXMASTER.AnimationEffect.RefreshDbError"));
      this.close();
      return {
        effects: [],
        tags: [],
      };
    }

    const overrides = game.settings.get(packageId, "customSpecialEffects") || {};

    const effects = [];
    const tagSet = new Set();

    for (const [_bucketKey, bucket] of Object.entries(buckets)) {
      for (const fx of bucket.effects) {
        const entry = foundry.utils.deepClone(fx);
        if (overrides[entry.file]) {
          foundry.utils.mergeObject(entry, overrides[entry.file]);
        }
        const folder = entry.favorite ? game.i18n.localize("FXMASTER.Favorites") : bucket.label;
        entry.tag = folder;
        effects.push(entry);
        tagSet.add(folder);
      }
    }

    effects.sort((a, b) => a.label.localeCompare(b.label));

    const allTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    const priority = ["Custom", game.i18n.localize("FXMASTER.Favorites")];
    const tags = [
      ...priority.filter((t) => allTags.includes(t)).map((t) => ({ key: t, label: t })),
      ...allTags.filter((t) => !priority.includes(t)).map((t) => ({ key: t, label: t })),
    ];

    this.fullEffects = effects;
    this.visibleEffects = effects;

    return { effects: [], tags };
  }

  async _onRender(...args) {
    super._onRender(...args);

    let windowPosition = game.user.getFlag(packageId, "dialog-position-specialeffects");
    if (windowPosition) {
      this.setPosition({
        top: windowPosition.top,
        left: windowPosition.left,
        height: windowPosition.height,
        width: windowPosition.width,
      });
    }
    const html = this.element;

    this.searchFilter.bind(html);

    const tagInput = html.querySelector(".specials-tag-filter");
    if (tagInput) {
      const hasOption = [...tagInput.options].some((o) => o.value === this.currentTag);
      if (!hasOption) this.currentTag = "";
      tagInput.value = this.currentTag;
      tagInput.addEventListener("input", (ev) => {
        this.currentTag = ev.currentTarget.value;
        this._applyFilters();
      });
    }

    this.list = html.querySelector(".specials-list");
    this.list.innerHTML = "";

    this.list.addEventListener("contextmenu", (ev) => {
      const tile = ev.target.closest(".special-effects");
      if (!tile) return;
      ev.preventDefault();

      SpecialEffectsManagement.editEffect(ev, tile);
    });

    this.sentinel = document.createElement("div");
    this.sentinel.classList.add("fxmaster-sentinel");
    this.list.append(this.sentinel);

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !this.searchMode) this._appendNextBatch();
      },
      { root: this.list, threshold: 0.1 },
    );
    this.observer.observe(this.sentinel);

    this._applyFilters();
  }

  _appendNextBatch() {
    const start = this.renderedCount;
    const end = Math.min(this.visibleEffects.length, start + this.batchSize);

    for (let i = start; i < end; i++) {
      const fx = this.visibleEffects[i];
      const tile = this._createTileElement(fx, i);
      this.list.insertBefore(tile, this.sentinel);
    }

    this.renderedCount = end;
    if (end >= this.visibleEffects.length) {
      this.observer.disconnect();
      this.sentinel.remove();
    }
  }

  _onSearchFilter(_event, _query, _rgx, _html) {
    this._applyFilters();
  }

  _applyFilters() {
    const raw = this.element.querySelector("input[data-search]")?.value.trim() || "";
    const tag = this.element.querySelector(".specials-tag-filter")?.value || "";

    this.currentTag = tag;
    let matcher;

    // Build the same matcher AST only if there’s a real query
    if (!raw.length) {
      matcher = () => true;
      this.searchMode = false;
    } else {
      this.searchMode = true;
      const clean = CONFIG.fxmaster.SearchFilterNS.cleanQuery(raw);
      const ast = this._parseSearchQuery(clean);
      matcher = (label) => this._evaluateSearchAST(ast, label.toLowerCase());
    }

    this.visibleEffects = this.fullEffects.filter((fx) => {
      if (!matcher(fx.label)) return false;
      if (tag && fx.tag !== tag) return false;
      return true;
    });

    this._resetInfiniteScroll();
  }

  _parseSearchQuery(query) {
    const tokens = query.match(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|[^\s()]+/gi) || [];
    let i = 0;
    const peek = () => tokens[i];
    const consume = (tok) => {
      if (peek() === tok) return tokens[i++];
      throw new Error(`Expected ${tok}`);
    };

    function parseExpression() {
      let node = parseTerm();
      while (peek() === "OR") {
        consume("OR");
        node = { type: "OR", left: node, right: parseTerm() };
      }
      return node;
    }

    function parseTerm() {
      let node = parseFactor();
      while (peek() && peek() !== ")" && peek() !== "OR") {
        if (peek() === "AND") consume("AND");
        const right = parseFactor();
        node = { type: "AND", left: node, right };
      }
      return node;
    }

    function parseFactor() {
      if (peek() === "NOT") {
        consume("NOT");
        return { type: "NOT", expr: parseFactor() };
      }
      if (peek() === "(") {
        consume("(");
        const expr = parseExpression();
        consume(")");
        return expr;
      }
      const word = tokens[i++];
      return { type: "WORD", value: word?.toLowerCase() };
    }

    const ast = parseExpression();
    if (i < tokens.length) throw new Error(`Unexpected token: ${peek()}`);
    return ast;
  }

  _evaluateSearchAST(node, label) {
    const parts = label?.toLowerCase().split(/[\W_]+/);
    switch (node.type) {
      case "WORD":
        return parts.some((p) => p.includes(node.value));
      case "NOT":
        return !this._evaluateSearchAST(node.expr, label);
      case "AND":
        return this._evaluateSearchAST(node.left, label) && this._evaluateSearchAST(node.right, label);
      case "OR":
        return this._evaluateSearchAST(node.left, label) || this._evaluateSearchAST(node.right, label);
      default:
        return false;
    }
  }

  static updateTagFilter(event, select) {
    const inst = SpecialEffectsManagement.instance;
    if (!inst) return;

    const raw = inst.element.querySelector("input[data-search]")?.value.trim() || "";
    const clean = CONFIG.fxmaster.SearchFilterNS.cleanQuery(raw);
    const rgx = new RegExp(clean, "i");

    inst.searchMode = false;
    inst.visibleEffects = inst.fullEffects.filter(
      (fx) => (!select.value || fx.tag === select.value) && (!raw || rgx.test(fx.label?.toLowerCase())),
    );
    inst._resetInfiniteScroll();
  }

  _resetInfiniteScroll() {
    this.renderedCount = 0;
    this.list.innerHTML = "";
    this.list.append(this.sentinel);
    this.observer.observe(this.sentinel);
    this._appendNextBatch();
  }

  static async editEffect(event, button) {
    const { SpecialEffectConfig } = await import("./special-effect-config.js");
    const el = button.closest(".special-effects");
    const idx = Number(el?.dataset.effectId);
    const inst = SpecialEffectsManagement.instance;

    const fx = inst.visibleEffects?.[idx] ?? inst.fullEffects?.[idx];
    if (!fx) {
      return ui.notifications.error(game.i18n.localize("FXMASTER.ErrorCannotFindEffect"));
    }

    const app = new SpecialEffectConfig();
    app.setDefault(fx);
    return app.render(true);
  }

  _createTileElement(effect, idx) {
    const c = document.createElement("div");
    c.classList.add("special-effects");
    c.dataset.effectId = idx;
    c.dataset.label = effect.label;
    c.dataset.tag = effect.tag;
    c.dataset.tooltip = `${game.i18n.localize("FXMASTER.AnimationEffect.RightClickForDetails")} ${effect.label}`;
    c.draggable = true;

    let thumb;
    if (effect.thumb) {
      thumb = document.createElement("img");
      thumb.classList.add("special-thumbnail");
      thumb.src = effect.thumb;
      thumb.alt = effect.label;
      thumb.dataset.video = effect.file;
    } else {
      thumb = document.createElement("video");
      thumb.classList.add("special-fallback-video");
      thumb.preload = "none";
      thumb.muted = true;
      thumb.loop = true;
      thumb.playsInline = true;
      thumb.dataset.video = effect.file;
      const src = document.createElement("source");
      src.src = effect.file;
      thumb.append(src);
    }
    c.append(thumb);

    thumb.addEventListener("mouseenter", () => {
      if (thumb.tagName === "VIDEO" && thumb.classList.contains("special-fallback-video")) {
        return thumb.play().catch(() => {});
      }
      if (c.querySelector("video")) return;
      const video = document.createElement("video");
      Object.assign(video, {
        src: thumb.dataset.video,
        muted: true,
        loop: true,
        playsInline: true,
      });
      video.classList.add("special-preview");
      video.style.cssText = "width:100%;height:100%";
      c.insertBefore(video, thumb);
      thumb.style.display = "none";
      video.addEventListener("loadeddata", () => video.play().catch(() => {}));
      video.addEventListener("mouseleave", () => {
        video.pause();
        video.remove();
        thumb.style.display = "";
      });
    });

    thumb.addEventListener("mouseleave", () => {
      if (thumb.tagName === "VIDEO" && thumb.classList.contains("special-fallback-video")) {
        thumb.pause();
        thumb.currentTime = 0;
      }
    });

    c.addEventListener("dragstart", this._onDragStart.bind(this));
    return c;
  }

  _onDragStart(event) {
    const el = event.currentTarget;
    const idx = Number(el.dataset.effectId);
    const fx = this.visibleEffects[idx] || this.fullEffects[idx];
    if (!fx) return;

    fx.type = "SpecialEffect";
    event.dataTransfer.setData("text/plain", JSON.stringify(fx));
  }

  async _onClose(...args) {
    super._onClose(...args);
    const { top, left, height, width } = this.position;
    game.user.setFlag(packageId, "dialog-position-specialeffects", { top, left, height, width });
  }
}
