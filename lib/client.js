window.__ModuleLoader__.load({
  id: "@vent0s/dsh-mod-workspace-files",
  factory: function(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Wire bound mirrored from upstream host.searchFiles. */
    const QUERY_MAX_CODE_UNITS = 100;

    /** Required services: generic RPC carrier, trigger registry, session/workspace data faces. */
    const inject = ["connection", "inputTriggers", "sessions", "workspaces"];

    /** Registered '#' source name (unique per trigger). */
    const SOURCE_NAME = "files";

    /**
     * Client plugin body: register the '#' files source over the DSH-Mod RPC
     * channel /mod-workspace-files. This keeps the mod independent of the
     * static host.searchFiles addition in @deepseek-ai/dsh-host-apiproxy.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      const connection = ctx.get("connection");
      const sessions = ctx.get("sessions");
      const workspaces = ctx.get("workspaces");
      const inputTriggers = ctx.get("inputTriggers");

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
            return { name: match.path, description: match.dir };
          });
        },
        onPick(pick) {
          // Plain-text reference: the draft and prompt carry the literal `#path`.
          return { text: "#" + pick.candidate.name + " " };
        },
        codec: {
          clipboardText: function(ref) { return "#" + ref; },
          serialize: function(ref) { return Promise.resolve("#" + ref); },
        },
      };

      ctx.effect(function() {
        return inputTriggers.registerSource(source);
      }, "dsh-mod-workspace-files: # source");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
