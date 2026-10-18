/**
 * DSH-Mod client half (local adaptation for unmodified deepseek-harness).
 *
 * Features:
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
 * 3. Key checks inside the stock Models page's existing provider cards.
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

    Object.assign(LOCALE_DICTIONARIES.zh, {
      providerIntro: "每次仅发送 1 次简短请求，验证并配置所选模型；原有模型列表保留。",
      providerLoading: "正在读取模型设置…", providerRetry: "重新加载",
      providerKey: "API Key", providerKeyNew: "输入 API Key", providerKeySaved: "已保存 Key；重新输入可更换并检查",
      providerMode: "账号类型", providerCoding: "Coding Plan", providerApi: "开放平台 API",
      providerModel: "验证模型", providerCooldown: "等待 {seconds} 秒后重试",
      providerCheck: "检查可用性并配置模型", providerChecking: "正在检查所选模型…", providerSaved: "已配置的模型",
      providerSuccess: "检查通过并已保存：",
      providerFailure: "无法连接模型配置服务，请确认 DSH 已加载最新 Mod。",
    });
    Object.assign(LOCALE_DICTIONARIES.en, {
      providerIntro: "One short request checks and configures the selected model. Existing models are kept.",
      providerLoading: "Loading model settings…", providerRetry: "Reload",
      providerKey: "API key", providerKeyNew: "Enter API key", providerKeySaved: "Key saved; enter a replacement to check again",
      providerMode: "Account type", providerCoding: "Coding Plan", providerApi: "Platform API",
      providerModel: "Model to check", providerCooldown: "Retry in {seconds}s",
      providerCheck: "Check access and configure models", providerChecking: "Checking selected model…", providerSaved: "Configured models",
      providerSuccess: "Checked and saved:",
      providerFailure: "Cannot connect to model setup. Check that DSH has loaded the updated Mod.",
    });

    Object.assign(LOCALE_DICTIONARIES.zh, {
      repos: "工作区仓库", repoButton: "仓库", repoLoading: "读取仓库状态…", repoEmpty: "尚未配置仓库",
      repoDirty: "未提交项", repoAhead: "待推送提交", repoBehind: "待拉取提交", repoUnknown: "上游状态未知",
      repoClean: "工作树干净，与已检查的上游一致", repoNoUpstream: "未设置上游", repoDetached: "分离 HEAD", repoUnborn: "尚无提交",
      repoLocal: "本地检查", repoRemote: "远端检查成功", repoNever: "未检查远端，仅本地引用", repoFetchFailed: "远端检查失败，计数可能过期",
      repoRefresh: "刷新状态", repoReload: "重新加载配置", repoSave: "保存仓库配置", repoPaths: "仓库相对路径（每行一个，根仓库填 .）",
      repoPathsPlaceholder: "例如：\n.\npackages/frontend\npackages/backend",
      repoAuto: "自动检查远端（每 5 分钟或配置间隔，仅 fetch）", repoHelp: "可让 agent 编辑工作区根目录的 .dsh-repos.json；仅跟踪列出的仓库。✎ 改动项 · ↑ 推送 · ↓ 拉取 · ? 未知 · ◷ 未联网核实。",
      repoFailure: "仓库服务不可用，请确认 DSH 已加载最新 Mod。", repoBusy: "检查中…", repoClose: "关闭仓库详情",
      repoChanged: "配置已在其他位置修改；重新加载后再编辑。", repoTiming: "本地 / 远端检查间隔（秒）",
    });
    Object.assign(LOCALE_DICTIONARIES.en, {
      repos: "Workspace repositories", repoButton: "Repos", repoLoading: "Loading repository status…", repoEmpty: "No repositories configured",
      repoDirty: "Uncommitted items", repoAhead: "Commits to push", repoBehind: "Commits to pull", repoUnknown: "Unknown upstream status",
      repoClean: "Clean worktree, matches the checked upstream", repoNoUpstream: "No upstream", repoDetached: "Detached HEAD", repoUnborn: "No commits yet",
      repoLocal: "Local check", repoRemote: "Remote check succeeded", repoNever: "Remote not checked; local refs only", repoFetchFailed: "Remote check failed; counts may be stale",
      repoRefresh: "Refresh status", repoReload: "Reload configuration", repoSave: "Save repository configuration", repoPaths: "Relative repository paths (one per line; . for workspace root)",
      repoPathsPlaceholder: "For example:\n.\npackages/frontend\npackages/backend",
      repoAuto: "Check remotes automatically (every 5 minutes or configured interval; fetch only)", repoHelp: "An agent can edit .dsh-repos.json in the workspace root. Only listed repositories are checked. ✎ changes · ↑ push · ↓ pull · ? unknown · ◷ remote not verified.",
      repoFailure: "Repository service unavailable. Check that DSH has loaded the updated Mod.", repoBusy: "Checking…", repoClose: "Close repository details",
      repoChanged: "Configuration changed elsewhere; reload before editing.", repoTiming: "Local / remote check intervals (seconds)",
    });

    /**
     * The '#-menu' surface. Tokens mirror the shipped trigger menu's
     * MenuView.module.css so the popup sits on the same elevation, anchors
     * the same way (absolute, bottom of the overlay anchor = composer top
     * edge), and follows the active theme.
     */
    var STYLE_ID = "dsh-mod-workspace-files-style";
    var STYLE_TEXT = [
      ".dsh-mod-repos { position:relative; font-size:12px; color:var(--dsw-alias-label-primary); }",
      ".dsh-mod-repos > button { border:0; background:transparent; color:inherit; padding:6px; border-radius:var(--dsw-radius-md,8px); cursor:pointer; font:inherit; white-space:nowrap; }",
      ".dsh-mod-repos > button:hover { background:var(--dsw-alias-interactive-bg-hover); }",
      ".dsh-mod-repo-panel { box-sizing:border-box; position:absolute; inset:auto; margin:0; top:calc(100% + 8px); left:0; width:min(420px,calc(100vw - 32px)); max-height:70vh; overflow:auto; padding:16px; z-index:100; color:inherit; font-size:12px; background:var(--dsw-alias-bg-base,#fff); border:1px solid var(--dsw-alias-border-inverted,#ddd); border-radius:var(--dsw-radius-lg,12px); box-shadow:var(--dsw-shadow-lv3); white-space:normal; }",
      ".dsh-mod-repo-panel h3 { margin:0 0 12px; font-size:14px; }",
      ".dsh-mod-repo-panel ul { list-style:none; padding:0; margin:12px 0; }",
      ".dsh-mod-repo-panel li { padding:10px 0; border-bottom:1px solid var(--dsw-alias-border-inverted,#ddd); overflow-wrap:anywhere; }",
      ".dsh-mod-repo-panel p { margin:6px 0; line-height:1.5; }",
      ".dsh-mod-repo-panel small { display:block; opacity:.72; margin-top:4px; }",
      ".dsh-mod-repo-panel textarea { box-sizing:border-box; width:100%; min-height:88px; resize:vertical; display:block; margin:6px 0 10px; color:inherit; background:var(--dsw-alias-bg-base,#fff); border:1px solid var(--dsw-alias-border-l3,#ddd); border-radius:var(--dsw-radius-md,8px); padding:8px; font:inherit; }",
      ".dsh-mod-repo-panel button { color:inherit; background:var(--dsw-alias-interactive-bg-hover,#eee); border:0; border-radius:var(--dsw-radius-md,8px); padding:6px 10px; cursor:pointer; font:inherit; }",
      ".dsh-mod-repo-panel button:disabled { opacity:.5; cursor:default; }",
      ".dsh-mod-repo-buttons { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 0; }",
      ".dsh-mod-repo-warning { color:var(--dsw-alias-state-warn-label,#ae6510); }",
      ".dsh-mod-provider-extension { display:flex; flex-direction:column; gap:12px; min-width:0; color:var(--dsw-alias-label-primary); }",
      ".dsh-mod-provider-card { display:flex; flex-direction:column; gap:12px; min-width:0; }",
      ".dsh-mod-provider-card label { display:flex; flex-direction:column; gap:6px; font-size:13px; }",
      ".dsh-mod-provider-card input,.dsh-mod-provider-card select { box-sizing:border-box; width:100%; min-height:38px; padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l3); color:inherit; background:var(--dsw-alias-bg-module-platform); font:inherit; }",
      ".dsh-mod-provider-extension p { margin:0; line-height:1.6; font-size:13px; overflow-wrap:anywhere; }",
      ".dsh-mod-provider-muted { color:var(--dsw-alias-label-tertiary); }",
      ".dsh-mod-provider-card button,.dsh-mod-provider-extension>button { align-self:flex-start; min-height:36px; padding:8px 14px; border:1px solid var(--dsw-alias-border-l3); border-radius:18px; background:transparent; color:inherit; cursor:pointer; font:inherit; }",
      ".dsh-mod-provider-card button[type=submit] { border-color:transparent; background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); }",
      ".dsh-mod-provider-card button[type=submit]:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }",
      ".dsh-mod-provider-card button:disabled { opacity:.55; cursor:default; }",
      ".dsh-mod-provider-error { color:var(--dsw-alias-state-warn-label); }",
      ".dsh-mod-provider-models { display:flex; flex-wrap:wrap; gap:6px; padding:0; margin:0; list-style:none; }",
      ".dsh-mod-provider-models li { font-size:12px; padding:4px 8px; border-radius:6px; background:var(--dsw-alias-interactive-bg-hover); overflow-wrap:anywhere; }",
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
        icon: react.createElement(primitives.IconFolderOpenOutlineRegular || primitives.IconFolderOpen16, { size: 16 }),
        "aria-label": t("openWorkspaceFolder"),
        onClick: function(event) {
          event.stopPropagation();
          openPath(owner.path).catch(function(reason) {
            console.warn("workspace open rejected:", reason);
          });
        },
      }));
    }

    function ProviderSetupCard(props) {
      var provider = props.provider, t = props.t;
      var keyState = react.useState(""), key = keyState[0], setKey = keyState[1];
      var modeState = react.useState(provider.mode), mode = modeState[0], setMode = modeState[1];
      var candidates = provider.candidates || provider.models;
      var modelState = react.useState(provider.defaultModel || candidates[0]?.id || ""), model = modelState[0], setModel = modelState[1];
      var busyState = react.useState(false), busy = busyState[0], setBusy = busyState[1];
      var retryState = react.useState(0), retryAt = retryState[0], setRetryAt = retryState[1];
      var secondsState = react.useState(0), seconds = secondsState[0], setSeconds = secondsState[1];
      var resultState = react.useState(null), result = resultState[0], setResult = resultState[1];
      var savedState = react.useState(provider.models), saved = savedState[0], setSaved = savedState[1];
      var configuredState = react.useState(provider.configured), configured = configuredState[0], setConfigured = configuredState[1];
      var active = react.useRef(null);
      react.useEffect(function() { return function() { if (active.current) active.current.abort(); }; }, []);
      react.useEffect(function() {
        var timer;
        function tick() {
          var left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
          setSeconds(left);
          if (left > 0) timer = setTimeout(tick, 1000);
        }
        tick();
        return function() { clearTimeout(timer); };
      }, [retryAt]);
      var selected = provider.modes.find(function(item) { return item.id === mode; });
      var submit = async function(event) {
        event.preventDefault();
        if (active.current || !key.trim() || !model || retryAt > Date.now()) return;
        var controller = new AbortController(); active.current = controller;
        setBusy(true); setResult(null);
        try {
          var response = await props.call("configure", { provider: provider.id, mode: mode, model: model, apiKey: key }, controller.signal);
          if (controller.signal.aborted) return;
          if (!response.ok) {
            setResult({ error: response.error.message });
            var wait = response.error.details?.retryAfterSeconds;
            if (Number.isFinite(wait) && wait > 0) { setSeconds(wait); setRetryAt(Date.now() + wait * 1000); }
            return;
          }
          setKey(""); setConfigured(true);
          setSaved(response.value.models.map(function(id) { return { id: id, name: id }; }));
          setResult(response.value);
        } catch {
          if (!controller.signal.aborted) setResult({ error: t("providerFailure") });
        } finally {
          active.current = null;
          if (!controller.signal.aborted) setBusy(false);
        }
      };
      return react.createElement("form", { className: "dsh-mod-provider-card", onSubmit: submit, "aria-label": provider.label },
        react.createElement("p", { className: "dsh-mod-provider-muted" }, t("providerIntro")),
        provider.modes.length > 1 && react.createElement("label", null, t("providerMode"),
          react.createElement("select", { value: mode, disabled: busy, onChange: function(event) { setMode(event.target.value); setResult(null); } },
            provider.modes.map(function(item) { return react.createElement("option", { key: item.id, value: item.id }, t(item.id === "api" ? "providerApi" : "providerCoding")); }))),
        react.createElement("p", { className: "dsh-mod-provider-muted" }, selected.baseURL),
        react.createElement("label", null, t("providerModel"),
          react.createElement("select", { value: model, disabled: busy, onChange: function(event) { setModel(event.target.value); setResult(null); } },
            candidates.map(function(item) { return react.createElement("option", { key: item.id, value: item.id }, item.id); }))),
        react.createElement("label", null, t("providerKey"), react.createElement("input", {
          type: "password", autoComplete: "off", spellCheck: false, value: key, disabled: busy,
          placeholder: t(configured ? "providerKeySaved" : "providerKeyNew"),
          onChange: function(event) { setKey(event.target.value); setResult(null); },
        })),
        react.createElement("button", { type: "submit", disabled: busy || seconds > 0 || !key.trim() || !model }, busy ? t("providerChecking") : seconds > 0 ? t("providerCooldown").replace("{seconds}", String(seconds)) : t("providerCheck")),
        result && react.createElement("p", { role: result.error ? "alert" : "status", className: result.error ? "dsh-mod-provider-error" : "" }, result.error || t("providerSuccess") + " " + result.verifiedModel),
        saved.length > 0 && react.createElement("div", null,
          react.createElement("p", { className: "dsh-mod-provider-muted" }, t("providerSaved")),
          react.createElement("ul", { className: "dsh-mod-provider-models" }, saved.map(function(model) { return react.createElement("li", { key: model.id }, model.id); }))));
    }

    // This is the existing Models row's extension seat, not a settings navigation item.
    function ProviderCardExtras(props) {
      var route = props.provider.provider;
      if (props.provider.settingsNs !== "llm-pi-ai" || (route !== "kimi-coding" && route !== "bigmodel")) return null;
      return react.createElement(ProviderCardLoader, { key: route, route: route, call: props.call, t: props.t });
    }

    function ProviderCardLoader(props) {
      var t = props.t;
      var state = react.useState(null), data = state[0], setData = state[1];
      var errorState = react.useState(false), error = errorState[0], setError = errorState[1];
      var retryState = react.useState(0), retry = retryState[0], setRetry = retryState[1];
      react.useEffect(function() {
        var controller = new AbortController();
        setError(false);
        props.call("describe", {}, controller.signal).then(function(response) {
          if (controller.signal.aborted) return;
          var provider = response.ok && response.value.providers.find(function(item) { return item.route === props.route; });
          if (provider) setData(provider); else setError(true);
        }).catch(function() { if (!controller.signal.aborted) setError(true); });
        return function() { controller.abort(); };
      }, [props.call, props.route, retry]);
      return react.createElement("div", { className: "dsh-mod-provider-extension" },
        error && react.createElement("p", { role: "alert" }, t("providerFailure")),
        error && react.createElement("button", { onClick: function() { setRetry(retry + 1); } }, t("providerRetry")),
        !data && !error && react.createElement("p", { role: "status" }, t("providerLoading")),
        data && react.createElement(ProviderSetupCard, { provider: data, call: props.call, t: t }));
    }

    function repoSymbols(rows, t, fetchIntervalSeconds) {
      var dirty = 0, ahead = 0, behind = 0, unknown = false, warning = false, stale = false;
      rows.forEach(function(row) {
        dirty += row.dirty || 0; ahead += row.ahead || 0; behind += row.behind || 0;
        unknown = unknown || !!row.error || row.ahead == null || row.behind == null;
        warning = warning || !!row.error || !!row.fetchError;
        stale = stale || (!row.error && !!row.upstream && (!row.fetchedAt || Date.now() - row.fetchedAt >= fetchIntervalSeconds * 1000));
      });
      var label = t("repoDirty") + ": " + dirty + ", " + t("repoAhead") + ": " + ahead + ", " + t("repoBehind") + ": " + behind;
      var icon = (dirty ? "✎" + dirty + " " : "") + (ahead ? "↑" + ahead + " " : "") + (behind ? "↓" + behind + " " : "");
      if (unknown) { icon += "? "; label += ", " + t("repoUnknown"); }
      if (warning) { icon += "! "; label += ", " + t("repoFetchFailed"); }
      else if (stale) { icon += "◷ "; label += ", " + t("repoNever"); }
      return { icon: icon.trim() || "✓", label: icon ? label : t("repoClean") };
    }

    function RepoStatusSessionAction(props) {
      var workspaces = props.useWorkspaces(function(state) { return state.items; });
      var owner = workspaces.find(function(workspace) { return workspace.sessionIds.includes(props.sessionId); });
      return owner ? react.createElement(RepoStatusPanel, { key: owner.workspaceId, workspaceId: owner.workspaceId, showLabel: props.showLabel, call: props.call, t: props.t }) : null;
    }

    function RepoStatusPanel(props) {
      var t = props.t;
      var dataState = react.useState(null), data = dataState[0], setData = dataState[1];
      var draftState = react.useState(null), draft = draftState[0], setDraft = draftState[1];
      var errorState = react.useState(""), error = errorState[0], setError = errorState[1];
      var busyState = react.useState(false), busy = busyState[0], setBusy = busyState[1];
      var openState = react.useState(false), opened = openState[0], setOpened = openState[1];
      var layoutState = react.useState({}), layout = layoutState[0], setLayout = layoutState[1];
      var controls = react.useRef({}), container = react.useRef(null), trigger = react.useRef(null), panel = react.useRef(null);
      var draftRef = react.useRef(null);
      react.useLayoutEffect(function() {
        if (!opened) return;
        var topLayer = typeof panel.current?.showPopover === "function";
        if (topLayer) panel.current.showPopover();
        function place() {
          var rect = container.current.getBoundingClientRect();
          var width = Math.min(420, window.innerWidth - 32);
          var left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
          setLayout({ position: topLayer ? "fixed" : "absolute", left: topLayer ? left : left - rect.left,
            top: topLayer ? rect.bottom + 8 : "calc(100% + 8px)", maxHeight: Math.max(100, window.innerHeight - rect.bottom - 24) });
        }
        place(); window.addEventListener("resize", place);
        window.addEventListener("transitionend", place);
        return function() { window.removeEventListener("resize", place); window.removeEventListener("transitionend", place); };
      }, [opened]);
      react.useEffect(function() {
        var stopped = false, active, timer, interval = 60000;
        function schedule() {
          clearTimeout(timer);
          if (!stopped && !document.hidden) timer = setTimeout(function() { void load(false); }, interval);
        }
        async function load(refresh, reload) {
          if (stopped || active || document.hidden) return;
          clearTimeout(timer);
          var controller = new AbortController(); active = controller; setBusy(true);
          try {
            var response = await props.call("status", { workspaceId: props.workspaceId, refresh: !!refresh }, controller.signal);
            if (stopped || controller.signal.aborted) return;
            if (!response.ok) throw new Error(response.error.message);
            setData(response.value); setError(""); interval = response.value.config.localIntervalSeconds * 1000;
            if (!draftRef.current || reload) {
              var next = { config: response.value.config, revision: response.value.revision, text: response.value.config.repos.join("\n") };
              draftRef.current = next; setDraft(next);
            }
          } catch (error) { if (!stopped && !controller.signal.aborted) setError(error.message || t("repoFailure")); }
          finally { active = null; if (!stopped) { setBusy(false); schedule(); } }
        }
        async function save(next) {
          if (stopped || active) return;
          clearTimeout(timer);
          var controller = new AbortController(); active = controller; setBusy(true);
          var saved = false;
          try {
            var response = await props.call("save", { workspaceId: props.workspaceId, revision: next.revision,
              config: Object.assign({}, next.config, { repos: next.text.split("\n").map(function(path) { return path.trim(); }).filter(Boolean) }) }, controller.signal);
            if (stopped || controller.signal.aborted) return;
            if (!response.ok) throw new Error(response.error.message);
            draftRef.current = null; saved = true;
          } catch (error) { if (!stopped) setError(error.message || t("repoFailure")); }
          finally { active = null; if (!stopped) { setBusy(false); if (saved) void load(false, true); else schedule(); } }
        }
        function visible() { if (document.hidden) clearTimeout(timer); else void load(false); }
        controls.current = { load: load, save: save };
        document.addEventListener("visibilitychange", visible);
        window.addEventListener("focus", visible);
        void load(false);
        return function() { stopped = true; active?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
      }, [props.workspaceId, props.call]);
      react.useEffect(function() {
        if (!opened) return;
        function pointer(event) { if (!container.current?.contains(event.target)) setOpened(false); }
        function key(event) { if (event.key === "Escape") { setOpened(false); trigger.current?.focus(); } }
        document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
        return function() { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
      }, [opened]);
      function updateDraft(patch) { var next = Object.assign({}, draft, patch); draftRef.current = next; setDraft(next); }
      function time(value) { return new Date(value).toLocaleString(); }
      var summary = data && data.repos.length ? repoSymbols(data.repos, t, data.config.fetchIntervalSeconds) : { icon: data ? "⑂" : "…", label: t(data ? "repoEmpty" : "repoLoading") };
      if (error) summary = { icon: "!", label: error };
      return react.createElement("div", { className: "dsh-mod-repos", ref: container },
        react.createElement("button", { type: "button", ref: trigger, title: t("repos") + ": " + summary.label, "aria-label": t("repos") + ": " + summary.label, "aria-expanded": opened,
          onClick: function() { setOpened(!opened); } }, props.showLabel ? t("repoButton") + " " + summary.icon + " ▾" : summary.icon),
        opened && react.createElement("section", { className: "dsh-mod-repo-panel", ref: panel,
          popover: typeof window.HTMLElement?.prototype.showPopover === "function" ? "manual" : undefined, style: layout, "aria-label": t("repos") },
          react.createElement("h3", null, t("repos")),
          error && react.createElement("p", { role: "alert", className: "dsh-mod-repo-warning" }, error),
          !data && !error && react.createElement("p", null, t("repoLoading")),
          data && react.createElement("ul", null, data.repos.map(function(row) {
            var symbols = repoSymbols([row], t, data.config.fetchIntervalSeconds);
            return react.createElement("li", { key: row.path },
              react.createElement("strong", null, row.path), " ", react.createElement("span", { title: symbols.label, "aria-label": symbols.label }, symbols.icon),
              row.error ? react.createElement("p", { className: "dsh-mod-repo-warning" }, row.error) : react.createElement(react.Fragment, null,
                react.createElement("small", null, row.detached ? t("repoDetached") : row.unborn ? t("repoUnborn") : row.branch, " · ", row.upstream || t("repoNoUpstream")),
                react.createElement("small", null, t("repoLocal"), ": ", time(row.checkedAt)),
                react.createElement("small", null, row.fetchedAt ? t("repoRemote") + ": " + time(row.fetchedAt) : t("repoNever")),
                row.fetchError && react.createElement("p", { className: "dsh-mod-repo-warning" }, t("repoFetchFailed"), " · ", row.fetchError)));
          })),
          data && data.repos.length === 0 && react.createElement("p", null, t("repoEmpty")),
          react.createElement("p", null, t("repoHelp")),
          draft && react.createElement(react.Fragment, null,
            data && data.revision !== draft.revision && react.createElement("p", { className: "dsh-mod-repo-warning" }, t("repoChanged")),
            react.createElement("label", null, t("repoPaths"), react.createElement("textarea", { value: draft.text, disabled: busy, spellCheck: false, placeholder: t("repoPathsPlaceholder"),
              onChange: function(event) { updateDraft({ text: event.target.value }); } })),
            react.createElement("label", null, react.createElement("input", { type: "checkbox", checked: draft.config.autoFetch, disabled: busy,
              onChange: function(event) { updateDraft({ config: Object.assign({}, draft.config, { autoFetch: event.target.checked }) }); } }), " ", t("repoAuto")),
            react.createElement("small", null, t("repoTiming"), ": ", draft.config.localIntervalSeconds, " / ", draft.config.fetchIntervalSeconds)),
          react.createElement("div", { className: "dsh-mod-repo-buttons" },
            react.createElement("button", { type: "button", disabled: busy, onClick: function() { controls.current.load(true); } }, t(busy ? "repoBusy" : "repoRefresh")),
            react.createElement("button", { type: "button", disabled: busy, onClick: function() { controls.current.load(false, true); } }, t("repoReload")),
            draft && react.createElement("button", { type: "button", disabled: busy || data?.revision !== draft.revision, onClick: function() { controls.current.save(draft); } }, t("repoSave")),
            react.createElement("button", { type: "button", onClick: function() { setOpened(false); trigger.current?.focus(); } }, t("repoClose")))));
    }

    /**
     * Client plugin body.
     * @param ctx - client root context carrying connection, slots, locale.
     * @param config - Optional feature switches; both default to true.
     */
    function apply(ctx, config) {
      config = config || {};
      var connection = ctx.get("connection");
      var slots = ctx.get("slots");
      var locale = ctx.get("locale");

      ctx.effect(function() {
        return locale.register(LOCALE_NS, LOCALE_DICTIONARIES);
      }, "dsh-mod-workspace-files: locale dictionaries");

      if (config.repoStatus !== false) {
        var callRepos = function(endpoint, payload, signal) { return connection.rpc.call("/mod-repos", endpoint, payload, signal); };
        slots.inject("conversation.session.header.actions", function() {
          return slots.register({ name: "conversation.session.header.actions", id: "dsh-mod-repos", order: 25, locale: LOCALE_NS,
            inject: function() { return { call: callRepos }; } }, RepoStatusSessionAction);
        });
        // Blank sessions hide header actions. Their workspace row has a separate
        // extension seat, so configuration is available before the first message.
        slots.inject("conversation.hero.options", function() {
          return slots.register({ name: "conversation.hero.options", id: "dsh-mod-repos", order: 25, locale: LOCALE_NS,
            inject: function() { return { call: callRepos, showLabel: true }; } }, RepoStatusSessionAction);
        });
      }

      if (connection.isLoopback) {
        var callProvider = function(endpoint, payload, signal) { return connection.rpc.call("/mod-providers", endpoint, payload, signal); };
        slots.inject("settings.models.provider-card", function() {
          return slots.register({
            name: "settings.models.provider-card", key: "llm-pi-ai", locale: LOCALE_NS,
            inject: function() { return { call: callProvider }; },
          }, ProviderCardExtras);
        });
      }

      if (config.openWorkspaceFolder !== false) {
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
      }

      if (config.hashFileSearch !== false) {
        var searchFiles = function(path, query, signal) {
          return connection.rpc.call("/mod-workspace-files", "search", { path: path, query: query }, signal);
        };
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
