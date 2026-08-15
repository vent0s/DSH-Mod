window.__ModuleLoader__.load({
  id: "@vent0s/dsh-mod-workspace-files",
  factory: function(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Wire bound mirrored from upstream host.searchFiles. */
    const QUERY_MAX_CODE_UNITS = 100;

    /** Required services: generic RPC carrier, trigger registry, session/workspace data faces. */
    const inject = ["connection", "slots", "locale", "inputTriggers", "sessions", "workspaces"];

    /** Registered '#' source name (unique per trigger). */
    const SOURCE_NAME = "files";
      const LOCALE_NS = "dshModWorkspace";
      const LOCALE_DICTIONARIES = {
        zh: {
          openWorkspaceFolder: "打开工作区目录",
          openWorkspaceFolderRail: "打开工作区目录",
          noWorkspaces: "暂无工作区",
        },
        en: {
          openWorkspaceFolder: "Open workspace folder",
          openWorkspaceFolderRail: "Open workspace folder",
          noWorkspaces: "No workspaces",
        },
      };

    /**
     * Client plugin body: register the '#' files source over the DSH-Mod RPC
     * channel /mod-workspace-files. This keeps the mod independent of the
     * static host.searchFiles addition in @deepseek-ai/dsh-host-apiproxy.
       * Candidates show and insert the Host's native absolute path, so the
       * prompt receives the drive-letter-rooted path (Windows) rather than a
       * workspace-relative reference.
     * @param ctx - client root context.
     */
    /** Footer action component: open any Workspace directory with the Host opener. */
      function OpenWorkspaceFolderAction(props) {
        const { wide, useSessions, useWorkspaces, useCanOpen, isLoopback, openPath, t } = props;
        const [open, setOpen] = react.useState(false);
        const workspaces = useWorkspaces(function(state) { return state.items; });
        const current = useSessions(function(state) { return state.current; });
        const canOpen = useCanOpen(function(value) { return value; });
        if (!isLoopback || !canOpen || workspaces.length === 0) return null;
        const currentWorkspaceId = workspaces.find(function(workspace) {
          return workspace.sessionIds.includes(current);
        })?.workspaceId;
        const items = workspaces.map(function(workspace) {
          return { id: String(workspace.workspaceId), label: workspace.title };
        });
        const anchor = react.createElement(primitives.Tooltip, {
          label: t(wide ? "openWorkspaceFolder" : "openWorkspaceFolderRail"),
          side: "right",
          delayMs: 500,
          disabled: wide,
        }, react.createElement(primitives.Button, {
          variant: "toolbar",
          size: "md",
          icon: react.createElement(primitives.IconFolderOpen16, { size: wide ? 14 : 18 }),
          "aria-label": t("openWorkspaceFolder"),
          onClick: function(event) { event.stopPropagation(); setOpen(function(v) { return !v; }); },
        }, wide ? t("openWorkspaceFolder") : null));
        return react.createElement(primitives.Menu, {
          open: open,
          onClose: function() { setOpen(false); },
          items: items,
          selectedIds: currentWorkspaceId === undefined ? [] : [String(currentWorkspaceId)],
          onSelect: function(id) {
            setOpen(false);
            const workspace = workspaces.find(function(candidate) { return String(candidate.workspaceId) === id; });
            if (workspace === undefined) return;
            openPath(workspace.path).catch(function(reason) {
              console.warn("workspace open rejected:", reason);
            });
          },
          align: "start",
          side: "top",
          portal: true,
          anchor: anchor,
        });
      }

      function apply(ctx) {
      const connection = ctx.get("connection");
      const sessions = ctx.get("sessions");
      const workspaces = ctx.get("workspaces");
      const inputTriggers = ctx.get("inputTriggers");
        const slots = ctx.get("slots");
        const locale = ctx.get("locale");

        ctx.effect(function() {
          return locale.register(LOCALE_NS, LOCALE_DICTIONARIES);
        }, "dsh-mod-workspace-files: locale dictionaries");

        let canOpen = false;
        const canOpenListeners = new Set();
        const canOpenSource = {
          getSnapshot: function() { return canOpen; },
          subscribe: function(listener) {
            canOpenListeners.add(listener);
            return function() { canOpenListeners.delete(listener); };
          },
        };
        const publishCanOpen = function(next) {
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
        const refreshCanOpen = async function() {
          try {
            const result = await connection.rpc.call("/mod-workspace-open", "describe", {});
            publishCanOpen(result.ok && result.value?.canOpen === true);
          } catch {
            publishCanOpen(false);
          }
        };
        void refreshCanOpen();
        ctx.on("connection/reset", function() { void refreshCanOpen(); });

        const openPath = async function(path) {
          const result = await connection.rpc.call("/mod-workspace-open", "open", { path });
          if (!result.ok) throw new Error(result.error.message);
        };

      /** The session's search root: its list-row cwd, else its owning Workspace path. */
      function searchRoot(sessionId) {
        const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
        if (cwd !== void 0 && cwd !== "") return cwd;
        return workspaces.list.getSnapshot().items
          .find(function(workspace) { return workspace.sessionIds.includes(sessionId); })?.path;
      }

      const source = {
        trigger: "#",
        name: SOURCE_NAME,
        async candidates(session, request) {
          const { query, signal } = request;
          // A bare '#' carries no query yet: never walk the whole tree.
          if (query === "" || signal.aborted) return [];
          const root = searchRoot(session.sessionId);
          if (root === void 0) return [];
          const bounded = query.length > QUERY_MAX_CODE_UNITS
            ? query.slice(0, QUERY_MAX_CODE_UNITS)
            : query;
          const result = await connection.rpc.call(
            "/mod-workspace-files",
            "search",
            { path: root, query: bounded },
            signal,
          );
          if (!result.ok) throw new Error(result.error.message);
          const matches = Array.isArray(result.value?.matches) ? result.value.matches : [];
          return matches.map(function(match) {
            return { name: match.path };
          });
        },
        onPick(pick) {
          // Full absolute path: the draft and prompt carry the native path itself.
          return { text: pick.candidate.name + " " };
        },
        codec: {
          clipboardText: function(ref) { return ref; },
          serialize: function(ref) { return Promise.resolve(ref); },
        },
      };

      ctx.effect(function() {
        return inputTriggers.registerSource(source);
      }, "dsh-mod-workspace-files: # source");

        slots.inject("sidebar.footer.action", function() {
          return slots.register(
            {
              name: "sidebar.footer.action",
              id: "dsh-mod-open-workspace",
              locale: LOCALE_NS,
              inject: function() {
                return {
                  isLoopback: connection.isLoopback,
                  openPath: openPath,
                  hooks: { canOpen: canOpenSource },
                };
              },
            },
            OpenWorkspaceFolderAction,
          );
        });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
