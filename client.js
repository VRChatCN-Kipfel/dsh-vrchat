/**
 * Client half: one ambient line under the composer reporting the cost of the
 * VRChat KB injection.
 *
 * Deliberately additive — a fresh slot id sits BESIDE the shipped entries
 * (`stats`, `better-stats`, `dsh-ppt`) instead of replacing one, and this slot
 * is `replaceRisk: none`.
 *
 * It carries no transport of its own: the numbers reach it by the Host
 * declaring a `wire.view` on a session projection, which the Client reads
 * through `props.useProjection`. Until that projection is registered the line
 * simply renders nothing, so the dock never shows a wrong number.
 */
window.__ModuleLoader__.load({
  id: "dsh-vrchat-kb",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Theme tokens only — literal colors stay reserved for artwork. */
    const root = {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "2px 8px",
      font: "var(--dsw-font-xxs-12)",
      color: "var(--dsw-alias-label-secondary)",
      whiteSpace: "nowrap",
      userSelect: "none",
    };
    const dot = {
      width: "5px",
      height: "5px",
      borderRadius: "50%",
      background: "var(--dsw-alias-state-business-primary)",
      flex: "0 0 auto",
    };

    /**
     * Compose the one-line summary from a projection view.
     *
     * The row shows the amount THIS session actually pays. The view carries both
     * tiers (`blockTokensLite` / `blockTokensPreset`) because the projection keeps
     * one definition per key, so a single field could only ever reflect whichever
     * instance registered first. The client cannot know which preset is active,
     * so it shows the smaller figure — the always-on tier — rather than a number
     * that might belong to the other mode.
     */
    function describe(view) {
      const parts = [];
      const tokens = [view.blockTokensLite, view.blockTokensPreset].filter(
        (value) => typeof value === "number" && value > 0,
      );
      if (tokens.length > 0) parts.push(`≥${Math.min(...tokens)} tok`);
      const calls =
        (view.digestCalls ?? 0) + (view.grepCalls ?? 0) + (view.readCalls ?? 0) + (view.scanCalls ?? 0);
      if (calls > 0) parts.push(`${calls} 次查询`);
      return parts.length === 0 ? null : `VRChat KB · ${parts.join(" · ")}`;
    }

    /**
     * @param props - slot props; `useProjection` selects one projection key.
     */
    function VrchatKbDock(props) {
      if (props.useProjection === undefined) return null;
      const view = props.useProjection("vrchatKb");
      if (view === null || view === undefined) return null;

      const label = describe(view);
      if (label === null) return null;

      const title =
        view.lastQuery === null || view.lastQuery === undefined
          ? "VRChat 知识库注入量（/vrchat stats 查看详情）"
          : `最近查询：${view.lastQuery}（/vrchat stats 查看详情）`;

      return h(
        "div",
        { style: root, title },
        h("span", { style: dot, "aria-hidden": true }),
        h("span", null, label),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            { name: "conversation.composer.dock", id: "vrchat-kb", order: 30 },
            VrchatKbDock,
          ),
        );
      },
    };
  },
});
