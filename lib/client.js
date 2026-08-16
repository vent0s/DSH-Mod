/**
 * DSH-Mod client half (local adaptation for unmodified deepseek-harness).
 *
 * Two features:
 *
 * 1. '#' workspace file search — implemented as an entry in the stock
 *    `conversation.input.overlay` slot (the same seam the shipped trigger
 *    menu uses). This harness's trigger pipeline only recognizes '/' and
 *    '@' (TriggerChar = '/' | '@'), so the upstream inputTriggers '#'
 *    source can never fire here. Instead the entry consumes the input
 *    machine's published state through the standard sessions.provide
 *    channel (`useInput` hook + `inputActions` prop), detects a trailing
 *    '#' token at a word boundary, queries /mod-workspace-files, and a
 *    pick replaces the token with the Host's native absolute path through
 *    `inputActions.setDraft` (one undo unit, CAS by construction).
 *
 * 2. Sidebar "open workspace folder" action (upstream design, kept).
 */

window.__ModuleLoader__.load({
  id: "@vent0s/dsh-mod-workspace-files",
  factory: function(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Wire bound mirrored from upstream host.searchFiles. */
    var QUERY_MAX_CODE_UNITS = 100;

    /** Required services: RPC carrier, slot system, locale registry. */
    var inject = ["connection", "slots", "locale"];

    var LOCALE_NS = "dshModWorkspace";
    var LOCALE_DICTIONARIES = {
      zh: {
        openWorkspaceFolder: "打开工作区目录",
        openWorkspaceFolderRail: "打开工作区目录",
        noWorkspaces: "暂无工作区",
        filesGroup: "文件",
        searching: "搜索中…",
        noMatches: "没有匹配的文件",
      },
      en: {
        openWorkspaceFolder: "Open workspace folder",
        openWorkspaceFolderRail: "Open workspace folder",
        noWorkspaces: "No workspaces",
        filesGroup: "Files",
        searching: "Searching…",
        noMatches: "No matching files",
      },
    };

    /**
     * The '#-menu' surface. Tokens mirror the shipped trigger menu's
     * MenuView.module.css so the popup sits on the same elevation, anchors
     * the same way (absolute, bottom of the overlay anchor = composer top
     * edge), and follows the active theme.
     */
    var STYLE_ID = "dsh-mod-workspace-files-style";
    var STYLE_TEXT = [
      ".dsh-mod-hash-menu {",
      "  position: absolute;",
      "  bottom: calc(100% + 4px);",
      "  left: 0;",
      "  z-index: 100;",
      "  min-width: min(260px, 100%);",
      "  max-width: min(640px, 100%);",
      "  max-height: 320px;",
      "  overflow: hidden;",
      "  padding: 4px;",
      "  display: flex;",
      "  flex-direction: column;",
      "  border: 1px solid var(--dsw-alias-border-inverted);",
      "  border-radius: 12px;",
      "  background: var(--dsw-specific-menu);",
      "  box-shadow: var(--dsw-shadow-lv3);",
      "}",
      ".dsh-mod-hash-viewport {",
      "  display: flex;",
      "  flex-direction: column;",
      "  min-height: 0;",
      "  overflow-y: auto;",
      "}",
      ".dsh-mod-hash-title {",
      "  padding: 8px 10px;",
      "  font-size: 12px;",
      "  line-height: 16px;",
      "  color: var(--dsw-alias-label-tertiary);",
      "}",
      ".dsh-mod-hash-row {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 8px;",
      "  width: 100%;",
      "  min-height: 40px;",
      "  padding: 8px 10px;",
      "  border: none;",
      "  border-radius: 10px;",
      "  background: transparent;",
      "  cursor: pointer;",
      "  font-size: 14px;",
      "  line-height: 22px;",
      "  font-family: inherit;",
      "  color: var(--dsw-alias-label-primary);",
      "  text-align: left;",
      "}",
      ".dsh-mod-hash-row:hover,",
      ".dsh-mod-hash-row.active { background: var(--dsw-alias-interactive-bg-hover); }",
      ".dsh-mod-hash-row.dim { color: var(--dsw-alias-label-dimmed); cursor: default; }",
      ".dsh-mod-hash-name {",
      "  flex: none;",
      "  max-width: 45%;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "}",
      ".dsh-mod-hash-dir {",
      "  flex: 1;",
      "  min-width: 0;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "  color: var(--dsw-alias-label-tertiary);",
      "}",
    ].join("\n");

    // The module system claims untagged <style> tags injected during
    // materialization for the plugin (HMR bookkeeping). Remove a previous
    // copy first so an HMR bundle reload never stacks duplicates.
    if (typeof document !== "undefined") {
      var previousStyle = document.getElementById(STYLE_ID);
      if (previousStyle !== null) previousStyle.remove();
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = STYLE_TEXT;
      document.head.appendChild(styleEl);
    }

    /**
     * Find the trailing '#' trigger token in a draft. The token runs from
     * the '#' to the draft end without whitespace, and the '#' sits at a
     * word boundary (draft start, after whitespace, or after a non-word
     * character — the same discipline as the harness's trigger detection).
     * @param draft - current draft text (may hold U+FFFC chip placeholders).
     * @returns {start, query} or null when no live trailing token exists.
     */
    function trailingHashToken(draft) {
      if (typeof draft !== "string" || draft === "") return null;
      var wordChar = /[\p{L}\p{N}_]/u;
      for (var i = draft.length - 1; i >= 0; i--) {
        var ch = draft.charAt(i);
        if (/\s/.test(ch)) return null; // whitespace before the trailing run: no token can reach the end
        if (ch !== "#") continue;
        var prev = i === 0 ? "" : draft.charAt(i - 1);
        var boundaryOk = i === 0 || /\s/.test(prev) || !wordChar.test(prev);
        if (!boundaryOk) continue;
        return { start: i, query: draft.slice(i + 1) };
      }
      return null;
    }

    /** The search root for one session: its list-row cwd, else its Workspace path. */
    function searchRoot(sessionsById, workspaces, sessionId) {
      var row = sessionsById == null ? undefined : sessionsById[sessionId];
      var cwd = row == null ? undefined : row.cwd;
      if (cwd !== undefined && cwd !== "") return cwd;
      var owner = (workspaces == null ? [] : workspaces).find(function(workspace) {
        return Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
      });
      return owner == null ? undefined : owner.path;
    }

    /**
     * '#' file menu overlay entry. Consumes the input machine's published
     * state (useInput) and write path (inputActions), the global session and
     * workspace lists, and the RPC-backed search closure from inject.
     */
    function FileHashMenu(props) {
      var useInput = props.useInput;
      var inputActions = props.inputActions;
      var sessionId = props.sessionId;
      var useSessions = props.useSessions;
      var useWorkspaces = props.useWorkspaces;
      var searchFiles = props.searchFiles;
      var t = props.t;

      var input = useInput(function(s) { return s; });
      var sessionsById = useSessions(function(state) { return state.byId; });
      var workspaces = useWorkspaces(function(state) { return state.items; });

      /** null = closed; "pending" = fetch in flight; array = results. */
      var itemsState = react.useState(null);
      var items = itemsState[0];
      var setItems = itemsState[1];
      var highlightState = react.useState(0);
      var highlight = highlightState[0];
      var setHighlight = highlightState[1];
      /** Escape closes the menu even while the token still matches. */
      var suppressedState = react.useState(false);
      var suppressed = suppressedState[0];
      var setSuppressed = suppressedState[1];

      var inputRef = react.useRef(input);
      inputRef.current = input;
      var itemsRef = react.useRef(items);
      itemsRef.current = items;
      var highlightRef = react.useRef(highlight);
      highlightRef.current = highlight;
      var fetchSeq = react.useRef(0);
      var listRef = react.useRef(null);

      var draft = input == null ? "" : input.draft;
      var plain = input == null ? false : input.phase === "plain";
      var token = plain ? trailingHashToken(draft) : null;
      var active = token !== null && token.query !== "";
      var root = searchRoot(sessionsById, workspaces, sessionId);
      var tokenKey = active ? token.start + "|" + token.query + "|" + input.draftRev : null;

      // A keystroke re-arms the menu after an Escape.
      react.useEffect(function() {
        setSuppressed(false);
      }, [tokenKey]);

      // Fetch candidates whenever the live token changes.
      react.useEffect(function() {
        if (tokenKey === null) {
          setItems(null);
          return;
        }
        if (root === undefined) {
          setItems([]);
          return;
        }
        var seq = ++fetchSeq.current;
        var controller = new AbortController();
        setItems("pending");
        var bounded = token.query.length > QUERY_MAX_CODE_UNITS
          ? token.query.slice(0, QUERY_MAX_CODE_UNITS)
          : token.query;
        var timer = setTimeout(function() {
          searchFiles(root, bounded, controller.signal).then(function(result) {
            if (seq !== fetchSeq.current || controller.signal.aborted) return;
            var matches = result.ok && Array.isArray(result.value && result.value.matches)
              ? result.value.matches
              : [];
            setItems(matches);
            setHighlight(0);
          }).catch(function() {
            if (seq === fetchSeq.current) setItems([]);
          });
        }, 120);
        return function() {
          clearTimeout(timer);
          controller.abort();
          fetchSeq.current += 1;
        };
      }, [tokenKey, root]);

      // Replace the trailing token span with one native path. The span is
      // read from the latest machine state at pick time, so the splice is
      // CAS-correct by construction; setDraft records one undo unit.
      var pick = function(match) {
        var current = inputRef.current;
        if (current == null || current.phase !== "plain" || inputActions == null) return;
        var live = trailingHashToken(current.draft);
        if (live === null) return;
        inputActions.setDraft(current.draft.slice(0, live.start) + match.path + " ");
        setSuppressed(true);
        setItems(null);
      };

      // Keyboard arbitration while the menu is open (capture phase: the
      // textarea never sees consumed keys, so Enter picks instead of
      // submitting and Escape closes instead of bubbling).
      var open = active && !suppressed && items !== null;
      react.useEffect(function() {
        if (!open) return;
        var onKeyDown = function(ev) {
          if (ev.defaultPrevented || ev.isComposing) return;
          var list = itemsRef.current;
          if (!Array.isArray(list)) return;
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            ev.stopPropagation();
            if (list.length > 0) setHighlight(function(h) { return (h + 1) % list.length; });
            return;
          }
          if (ev.key === "ArrowUp") {
            ev.preventDefault();
            ev.stopPropagation();
            if (list.length > 0) setHighlight(function(h) { return (h - 1 + list.length) % list.length; });
            return;
          }
          if (ev.key === "Enter") {
            if (list.length === 0) return; // no results: let the draft submit normally
            ev.preventDefault();
            ev.stopPropagation();
            var at = Math.min(highlightRef.current, list.length - 1);
            pick(list[at]);
            return;
          }
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            setSuppressed(true);
            setItems(null);
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return function() { document.removeEventListener("keydown", onKeyDown, true); };
      });

      // Dismiss on pointer outside the menu AND outside the composer card
      // (clicking the textarea must not close the menu while the token lives).
      react.useEffect(function() {
        if (!open) return;
        var onPointerDown = function(ev) {
          if (!(ev.target instanceof Node)) return;
          if (listRef.current !== null && listRef.current.contains(ev.target)) return;
          var composerCard = listRef.current !== null
            ? listRef.current.closest("[data-composer-card]")
            : null;
          if (composerCard !== null && composerCard.contains(ev.target)) return;
          setSuppressed(true);
          setItems(null);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return function() { document.removeEventListener("pointerdown", onPointerDown, true); };
      }, [open]);

      if (!open) return null;

      var rows;
      if (items === "pending") {
        rows = react.createElement("div", { className: "dsh-mod-hash-row dim" }, t("searching"));
      } else if (items.length === 0) {
        rows = react.createElement("div", { className: "dsh-mod-hash-row dim" }, t("noMatches"));
      } else {
        rows = items.map(function(match, index) {
          return react.createElement("button", {
            key: match.path,
            type: "button",
            role: "option",
            "aria-selected": index === highlight,
            className: "dsh-mod-hash-row" + (index === highlight ? " active" : ""),
            // mousedown keeps focus in the textarea (combobox pattern).
            onMouseDown: function(ev) {
              ev.preventDefault();
              pick(match);
            },
            onMouseEnter: function() { setHighlight(index); },
          },
            react.createElement("span", { className: "dsh-mod-hash-name" }, match.name),
            react.createElement("span", { className: "dsh-mod-hash-dir" }, match.dir));
        });
      }

      return react.createElement("div", {
        ref: listRef,
        className: "dsh-mod-hash-menu",
        role: "listbox",
        "aria-label": t("filesGroup"),
      },
        react.createElement("div", { className: "dsh-mod-hash-title" }, t("filesGroup")),
        react.createElement("div", { className: "dsh-mod-hash-viewport" }, rows));
    }

    /**
     * Session-header action: open the current session's workspace folder in
     * the OS file manager. Hides for sessions without an owning workspace
     * (the ungrouped bucket), off-loopback connections, or hosts that
     * cannot open a native path.
     * @param props - slot shares: session id, workspace list, opener.
     */
    function OpenWorkspaceFolderSessionAction(props) {
      var sessionId = props.sessionId;
      var useWorkspaces = props.useWorkspaces;
      var useCanOpen = props.useCanOpen;
      var isLoopback = props.isLoopback;
      var openPath = props.openPath;
      var t = props.t;

      var workspaces = useWorkspaces(function(state) { return state.items; });
      var canOpen = useCanOpen(function(value) { return value; });
      var owner = workspaces.find(function(workspace) {
        return Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
      });
      if (!isLoopback || !canOpen || owner === undefined) return null;
      return react.createElement(primitives.Tooltip, {
        label: t("openWorkspaceFolder"),
        side: "bottom",
        delayMs: 500,
      }, react.createElement(primitives.Button, {
        variant: "toolbar",
        size: "md",
        icon: react.createElement(primitives.IconFolderOpen16, { size: 16 }),
        "aria-label": t("openWorkspaceFolder"),
        onClick: function(event) {
          event.stopPropagation();
          openPath(owner.path).catch(function(reason) {
            console.warn("workspace open rejected:", reason);
          });
        },
      }));
    }

    /**
     * Client plugin body.
     * @param ctx - client root context carrying connection, slots, locale.
     */
    function apply(ctx) {
      var connection = ctx.get("connection");
      var slots = ctx.get("slots");
      var locale = ctx.get("locale");

      ctx.effect(function() {
        return locale.register(LOCALE_NS, LOCALE_DICTIONARIES);
      }, "dsh-mod-workspace-files: locale dictionaries");

      var canOpen = false;
      var canOpenListeners = new Set();
      var canOpenSource = {
        getSnapshot: function() { return canOpen; },
        subscribe: function(listener) {
          canOpenListeners.add(listener);
          return function() { canOpenListeners.delete(listener); };
        },
      };
      var publishCanOpen = function(next) {
        if (Object.is(canOpen, next)) return;
        canOpen = next;
        for (const listener of [...canOpenListeners]) {
          try {
            listener();
          } catch (error) {
            console.error("[dsh-mod] canOpen listener threw:", error);
          }
        }
      };
      var refreshCanOpen = async function() {
        try {
          var result = await connection.rpc.call("/mod-workspace-open", "describe", {});
          publishCanOpen(result.ok && result.value?.canOpen === true);
        } catch {
          publishCanOpen(false);
        }
      };
      void refreshCanOpen();
      ctx.on("connection/reset", function() { void refreshCanOpen(); });

      var openPath = async function(path) {
        var result = await connection.rpc.call("/mod-workspace-open", "open", { path: path });
        if (!result.ok) throw new Error(result.error.message);
      };

      var searchFiles = function(path, query, signal) {
        return connection.rpc.call("/mod-workspace-files", "search", { path: path, query: query }, signal);
      };

      slots.inject("conversation.session.header.actions", function() {
        return slots.register(
          {
            name: "conversation.session.header.actions",
            id: "dsh-mod-open-workspace",
            order: 30,
            locale: LOCALE_NS,
            inject: function() {
              return {
                isLoopback: connection.isLoopback,
                openPath: openPath,
                hooks: { canOpen: canOpenSource },
              };
            },
          },
          OpenWorkspaceFolderSessionAction,
        );
      });

      slots.inject("conversation.input.overlay", function() {
        return slots.register(
          {
            name: "conversation.input.overlay",
            id: "dsh-mod-hash-files",
            order: 1,
            locale: LOCALE_NS,
            inject: function() {
              return { searchFiles: searchFiles };
            },
          },
          FileHashMenu,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
