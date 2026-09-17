// dsh-port-share 设置页客户端（零构建：手写普通 JS，无 JSX/打包器）
//
// 在 DSH 设置页注册一级入口「端口共享」：
//   - 查看所有共享端口及其实时状态（局域网 URL / 公网隧道 URL）
//   - 新增共享（端口 / 服务地址 / 备注 / 局域网 / 公网开关）
//   - 开关局域网 / 公网分享、移除共享
//
// 与 Host 的通信走 DSH 官方 RPC 通道（ctx.connection.rpc.call），
// wire 协议见 lib/web-rpc.js（/dsh-port-share，client-request / server-response）。
//
// 打包说明：本文件即最终产物（client/client.js）。文件开头的
// window.__ModuleLoader__.load(...) 包装是 DSH 客户端模块系统的标准接入方式
// （与 dsh-pocket 的 client/client.js 同构），`require("react")` 由 DSH 提供。
// 改动本文件后无需构建，重启 dsh web / DSH Desktop 即生效（junction 软链开发下即时生效）。

window.__ModuleLoader__.load({
  id: "dsh-port-share",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var { createElement: h, useEffect, useState, useCallback } = React;

    // ---------- RPC 契约（与 lib/web-rpc.js 的 ENDPOINTS 保持一致） ----------
    var RPC_CHANNEL = "/dsh-port-share";
    var EP = { list: "list", status: "status", add: "add", update: "update", remove: "remove" };

    // ---------- 文案（zh / en，随 locale 注册进 DSH；无 locale 服务时按浏览器语言兜底） ----------
    var ZH = {
      section: "端口共享",
      desc: "把本地网络服务分享给局域网和公网（手机同一 WiFi 直接访问，或通过 Cloudflare 公网隧道）。也可以直接在会话里对 DSH 说「分享 3000 端口」来添加。",
      addTitle: "新增共享",
      port: "端口",
      portPh: "例如 3000",
      host: "服务地址",
      hostPh: "默认 127.0.0.1",
      name: "备注名（可选）",
      lanLabel: "局域网",
      publicLabel: "公网",
      lanHint: "同 WiFi / 网段内手机可访问",
      publicHint: "通过 Cloudflare 隧道，任意网络可访问",
      add: "添加共享",
      adding: "添加中…",
      refresh: "刷新",
      listTitle: "当前共享",
      empty: "还没有任何共享。在上方输入端口号添加，或直接对我说「把 3000 端口分享到局域网」。",
      loading: "加载中…",
      running: "运行中",
      waiting: "等待服务启动",
      abnormal: "异常",
      lanOn: "局域网：开",
      lanOff: "局域网：关",
      pubOn: "公网：开",
      pubOff: "公网：关",
      notReady: "未就绪",
      proxyNote: "TCP 代理 {lanPort} → {host}:{port}",
      directNote: "服务已绑定全部接口，直连",
      publicWarn: "公网隧道 URL 每次重启会变，以列表显示为准",
      remove: "移除",
      removing: "移除中…",
      opFailed: "操作失败",
      badPort: "端口必须是 1-65535 的整数",
      targetDown: "目标服务 {host}:{port} 未启动或不可达，共享暂停，服务启动后自动恢复",
      lanErr: "局域网共享失败",
      pubErr: "公网隧道失败",
      updated: "更新于 {time}",
    };

    var EN = {
      section: "Port Share",
      desc: "Share local network services to LAN and public internet (phone on the same WiFi, or via a Cloudflare quick tunnel). You can also just tell DSH in chat: \u201Cshare port 3000\u201D.",
      addTitle: "New Share",
      port: "Port",
      portPh: "e.g. 3000",
      host: "Host",
      hostPh: "default 127.0.0.1",
      name: "Note (optional)",
      lanLabel: "LAN",
      publicLabel: "Public",
      lanHint: "Reachable by phones on the same WiFi / subnet",
      publicHint: "Via Cloudflare tunnel, reachable from any network",
      add: "Add Share",
      adding: "Adding\u2026",
      refresh: "Refresh",
      listTitle: "Active Shares",
      empty: "No shares yet. Add one above, or tell DSH in chat: \u201Cshare port 3000 on LAN\u201D.",
      loading: "Loading\u2026",
      running: "Running",
      waiting: "Waiting for service",
      abnormal: "Error",
      lanOn: "LAN: on",
      lanOff: "LAN: off",
      pubOn: "Public: on",
      pubOff: "Public: off",
      notReady: "not ready",
      proxyNote: "TCP proxy {lanPort} \u2192 {host}:{port}",
      directNote: "Service binds all interfaces, direct link",
      publicWarn: "Tunnel URL changes on restart; trust the list",
      remove: "Remove",
      removing: "Removing\u2026",
      opFailed: "Operation failed",
      badPort: "Port must be an integer in 1..65535",
      targetDown: "Target {host}:{port} is down; share paused, auto-resumes when the service starts",
      lanErr: "LAN share failed",
      pubErr: "Public tunnel failed",
      updated: "Updated {time}",
    };

    function fmtText(s, vars) {
      if (!vars) return s;
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          s = String(s).split("{" + k + "}").join(String(vars[k]));
        }
      }
      return s;
    }

    function makeT(dict) {
      return function (key, vars) {
        var s = dict[key] || ZH[key] || key;
        return fmtText(s, vars);
      };
    }

    var fallbackT = (function () {
      var lang = "";
      try { lang = String(navigator.language || "").toLowerCase(); } catch (e) { /* ignore */ }
      return makeT(lang.indexOf("zh") === 0 ? ZH : EN);
    })();

    // ---------- 样式（复用 DSH 设计系统 CSS 变量，与 dsh-pocket 一致） ----------
    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 560, padding: "4px 0 24px" },
      muted: { color: "var(--dsw-alias-label-tertiary,#8b93a1)", fontSize: 12, lineHeight: 1.6, margin: 0 },
      card: { background: "var(--dsw-alias-bg-layer-1,#fff)", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 12, padding: "16px 20px" },
      cardTitle: { fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "var(--dsw-alias-label-primary,inherit)" },
      row: { display: "flex", gap: 12, flexWrap: "wrap" },
      field: { flex: "1 1 160px", marginBottom: 10 },
      label: { display: "block", fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", margin: "0 0 4px" },
      input: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, color: "var(--dsw-alias-label-primary,inherit)", background: "var(--dsw-alias-bg-layer-0,#fafafa)", border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", borderRadius: 8, padding: "7px 10px", outline: "none" },
      switchRow: { display: "flex", gap: 12, flexWrap: "wrap", margin: "2px 0 12px" },
      switch: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-secondary,#6b7280)", height: 30, padding: "0 12px", borderRadius: 999, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 },
      switchOn: { border: "none", background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))", color: "var(--dsw-alias-label-primary-foreground,#fff)" },
      primary: { font: "inherit", cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))", color: "var(--dsw-alias-label-primary-foreground,#fff)", height: 36, padding: "0 18px", borderRadius: 999, fontSize: 13, fontWeight: 500, display: "inline-flex", alignItems: "center", justifyContent: "center" },
      primaryDisabled: { opacity: 0.55, cursor: "default" },
      ghost: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)", height: 36, padding: "0 16px", borderRadius: 999, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center" },
      ghostDanger: { color: "var(--dsw-alias-state-danger-primary,#dc2626)" },
      error: { color: "var(--dsw-alias-state-danger-primary,#dc2626)", fontSize: 12, lineHeight: 1.5, margin: 0 },
      listHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
      listTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary,inherit)" },
      empty: { border: "1px dashed var(--dsw-alias-border-l2,#d1d5db)", borderRadius: 12, padding: "18px 20px", fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", lineHeight: 1.6 },
      shareHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 },
      shareTitle: { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary,inherit)" },
      pill: { fontSize: 11, padding: "2px 10px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", color: "var(--dsw-alias-label-secondary,#6b7280)" },
      pillOk: { background: "var(--dsw-alias-state-success-primary,#16a34a)", borderColor: "transparent", color: "#fff" },
      pillWait: { background: "var(--dsw-alias-state-warn-primary,#d97706)", borderColor: "transparent", color: "#fff" },
      pillErr: { background: "var(--dsw-alias-state-danger-primary,#dc2626)", borderColor: "transparent", color: "#fff" },
      line: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, lineHeight: 1.6, padding: "4px 0", flexWrap: "wrap" },
      lineLabel: { flex: "0 0 auto", minWidth: 84, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", paddingTop: 1 },
      url: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, wordBreak: "break-all", color: "var(--dsw-alias-brand-primary,#4f6ef7)", textDecoration: "none" },
      lineErr: { color: "var(--dsw-alias-state-danger-primary,#dc2626)", fontSize: 12, wordBreak: "break-all" },
      note: { fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8b93a1)", lineHeight: 1.5 },
      actions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexWrap: "wrap" },
      link: { color: "inherit" },
    };

    // ---------- 子组件 ----------

    function StatusPill({ item, t }) {
      var cls = styles.pill;
      var text = t("running");
      if (item.targetReachable === true) {
        cls = styles.pillOk;
      } else if (item.targetReachable === false) {
        cls = styles.pillWait;
        text = t("waiting");
      } else {
        cls = styles.pillErr;
        text = t("abnormal");
      }
      return h("span", { style: cls }, text);
    }

    function Toggle({ on, labelOn, labelOff, onClick, disabled }) {
      return h(
        "button",
        {
          type: "button",
          style: Object.assign({}, styles.switch, on ? styles.switchOn : null, disabled ? { opacity: 0.55, cursor: "default" } : null),
          disabled: !!disabled,
          onClick: onClick,
          title: on ? labelOn : labelOff,
        },
        h("span", { style: { fontSize: 11, opacity: 0.9 } }, on ? "\u25CF" : "\u25CB"),
        " ",
        on ? labelOn : labelOff,
      );
    }

    function ShareCard({ item, t, busy, onPatch, onRemove }) {
      var note = null;
      if (item.lan && item.mode === "proxy" && item.lanPort) {
        note = t("proxyNote", { lanPort: item.lanPort, host: item.host, port: item.port });
      } else if (item.lan && item.mode === "direct") {
        note = t("directNote");
      }
      var shareError = null;
      if (item.targetReachable === false) shareError = t("targetDown", { host: item.host, port: item.port });
      else if (item.error) shareError = item.error;

      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: styles.shareHead },
          h("span", { style: styles.shareTitle }, String(item.port) + (item.name ? " \u00B7 " + item.name : "")),
          h(StatusPill, { item, t }),
        ),
        item.lan
          ? h(
              "div",
              { style: styles.line },
              h("span", { style: styles.lineLabel }, t("lanLabel")),
              item.lanUrl
                ? h("a", { style: styles.url, href: item.lanUrl, target: "_blank", rel: "noreferrer" }, item.lanUrl)
                : h("span", { style: styles.note }, t("notReady")),
              h(
                "span",
                { style: { marginLeft: "auto" } },
                h(Toggle, {
                  on: item.lan,
                  labelOn: t("lanOn"),
                  labelOff: t("lanOff"),
                  disabled: busy,
                  onClick: () => onPatch(item.port, { lan: !item.lan }),
                }),
              ),
            )
          : null,
        item.public
          ? h(
              "div",
              { style: styles.line },
              h("span", { style: styles.lineLabel }, t("publicLabel")),
              item.tunnelUrl
                ? h("a", { style: styles.url, href: item.tunnelUrl, target: "_blank", rel: "noreferrer" }, item.tunnelUrl)
                : h("span", { style: styles.note }, t("notReady") + (item.tunnelError ? " (" + item.tunnelError + ")" : "")),
              h(
                "span",
                { style: { marginLeft: "auto" } },
                h(Toggle, {
                  on: item.public,
                  labelOn: t("pubOn"),
                  labelOff: t("pubOff"),
                  disabled: busy,
                  onClick: () => onPatch(item.port, { public: !item.public }),
                }),
              ),
            )
          : h(
              "div",
              { style: styles.line },
              h("span", { style: styles.lineLabel }, t("publicLabel")),
              h("span", { style: styles.note }, t("pubOff")),
              h(
                "span",
                { style: { marginLeft: "auto" } },
                h(Toggle, {
                  on: item.public,
                  labelOn: t("pubOn"),
                  labelOff: t("pubOff"),
                  disabled: busy,
                  onClick: () => onPatch(item.port, { public: !item.public }),
                }),
              ),
            ),
        note ? h("div", { style: styles.note }, note) : null,
        item.public ? h("div", { style: styles.note }, t("publicWarn")) : null,
        shareError ? h("div", { style: styles.lineErr }, shareError) : null,
        h(
          "div",
          { style: styles.actions },
          h(
            "button",
            { type: "button", style: Object.assign({}, styles.ghost, styles.ghostDanger), disabled: busy, onClick: () => onRemove(item.port) },
            busy ? t("removing") : t("remove"),
          ),
        ),
      );
    }

    // ---------- 设置页主组件 ----------

    function PortShareSettingsTab({ rpcCall, t }) {
      var _a = useState({ port: "", host: "127.0.0.1", name: "", lan: true, public: false });
      var form = _a[0];
      var setForm = _a[1];
      var _b = useState(null); // null = 首次加载中
      var items = _b[0];
      var setItems = _b[1];
      var _c = useState(false);
      var busy = _c[0];
      var setBusy = _c[1];
      var _d = useState(null); // 正在操作（移除/开关）的端口
      var busyPort = _d[0];
      var setBusyPort = _d[1];
      var _e = useState(null);
      var error = _e[0];
      var setError = _e[1];

      var load = useCallback(
        function () {
          return rpcCall(EP.list, {})
            .then(function (res) {
              if (res && res.ok === true) {
                setItems(Array.isArray(res.value && res.value.items) ? res.value.items : []);
                setError(null);
              } else {
                setItems([]);
                setError((res && res.error && res.error.message) || t("opFailed"));
              }
            })
            .catch(function (err) {
              setItems([]);
              setError((err && err.message) || String(err));
            });
        },
        [rpcCall, t],
      );

      useEffect(
        function () {
          void load();
          var timer = setInterval(function () { void load(); }, 5000);
          return function () { clearInterval(timer); };
        },
        [load],
      );

      function addShare() {
        var port = Number(form.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setError(t("badPort"));
          return;
        }
        setBusy(true);
        setError(null);
        var payload = { port: port, host: form.host.trim() || "127.0.0.1" };
        if (form.name.trim()) payload.name = form.name.trim();
        if (form.lan !== true) payload.lan = false;
        if (form.public) payload.public = true;
        rpcCall(EP.add, payload)
          .then(function (res) {
            if (!res || res.ok !== true) throw new Error((res && res.error && res.error.message) || t("opFailed"));
            setForm(function (f) { return { port: "", host: f.host, name: "", lan: f.lan, public: f.public }; });
            return load();
          })
          .catch(function (err) { setError((err && err.message) || String(err)); })
          .finally(function () { setBusy(false); });
      }

      function patchShare(port, patch) {
        setBusyPort(port);
        setError(null);
        rpcCall(EP.update, Object.assign({ port: port }, patch))
          .then(function (res) {
            if (!res || res.ok !== true) throw new Error((res && res.error && res.error.message) || t("opFailed"));
            return load();
          })
          .catch(function (err) { setError((err && err.message) || String(err)); })
          .finally(function () { setBusyPort(null); });
      }

      function removeShare(port) {
        setBusyPort(port);
        setError(null);
        rpcCall(EP.remove, { port: port })
          .then(function (res) {
            if (!res || res.ok !== true) throw new Error((res && res.error && res.error.message) || t("opFailed"));
            return load();
          })
          .catch(function (err) { setError((err && err.message) || String(err)); })
          .finally(function () { setBusyPort(null); });
      }

      return h(
        "div",
        { style: styles.wrap },
        h("p", { style: styles.muted }, t("desc")),
        h(
          "div",
          { style: styles.card },
          h("div", { style: styles.cardTitle }, t("addTitle")),
          h(
            "div",
            { style: styles.row },
            h(
              "div",
              { style: styles.field },
              h("label", { style: styles.label }, t("port")),
              h("input", {
                style: styles.input,
                type: "number",
                min: 1,
                max: 65535,
                value: form.port,
                placeholder: t("portPh"),
                onChange: function (e) { setForm(Object.assign({}, form, { port: e.target.value })); },
              }),
            ),
            h(
              "div",
              { style: styles.field },
              h("label", { style: styles.label }, t("host")),
              h("input", {
                style: styles.input,
                value: form.host,
                placeholder: t("hostPh"),
                onChange: function (e) { setForm(Object.assign({}, form, { host: e.target.value })); },
              }),
            ),
          ),
          h(
            "div",
            { style: styles.field },
            h("label", { style: styles.label }, t("name")),
            h("input", {
              style: styles.input,
              value: form.name,
              placeholder: t("name"),
              onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })); },
            }),
          ),
          h(
            "div",
            { style: styles.switchRow },
            h(Toggle, {
              on: form.lan,
              labelOn: t("lanLabel"),
              labelOff: t("lanLabel"),
              onClick: function () { setForm(Object.assign({}, form, { lan: !form.lan })); },
            }),
            h(Toggle, {
              on: form.public,
              labelOn: t("publicLabel"),
              labelOff: t("publicLabel"),
              onClick: function () { setForm(Object.assign({}, form, { public: !form.public })); },
            }),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
            h(
              "button",
              { type: "button", style: Object.assign({}, styles.primary, busy ? styles.primaryDisabled : null), disabled: busy, onClick: addShare },
              busy ? t("adding") : t("add"),
            ),
            h("span", { style: styles.muted }, form.lan ? t("lanHint") : "", form.public ? " \u00B7 " + t("publicHint") : ""),
          ),
        ),
        error ? h("p", { style: styles.error }, error) : null,
        h(
          "div",
          { style: styles.listHead },
          h("span", { style: styles.listTitle }, t("listTitle") + (Array.isArray(items) ? " (" + items.length + ")" : "")),
          h(
            "button",
            { type: "button", style: styles.ghost, onClick: function () { void load(); } },
            t("refresh"),
          ),
        ),
        items === null
          ? h("div", { style: styles.empty }, t("loading"))
          : items.length === 0
            ? h("div", { style: styles.empty }, t("empty"))
            : items.map(function (item) {
                return h(ShareCard, {
                  key: String(item.port),
                  item: item,
                  t: t,
                  busy: busyPort === item.port,
                  onPatch: patchShare,
                  onRemove: removeShare,
                });
              }),
      );
    }

    // ---------- Cordis 客户端插件 ----------

    var name = "dsh-port-share";
    var inject = ["connection", "slots", "locale"];

    function apply(ctx) {
      if (!ctx || !ctx.connection || typeof ctx.connection.rpc !== "object" || typeof ctx.connection.rpc.call !== "function") {
        return; // 无 RPC 通道（极端环境），设置页不可用
      }
      var rpcCall = function (endpoint, payload, signal) {
        return ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal);
      };

      // locale 已在 inject 中声明，直接从 ctx.locale 读取
      var locale = ctx.locale;
      var translate = fallbackT;
      if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
        ctx.effect(function () { return locale.register(name, { zh: ZH, en: EN }); }, name + ": locale dictionaries");
        var bound = locale.bind(name);
        translate = function (key, vars) {
          var s = bound(key);
          if (s === key) s = (ZH[key] || EN[key] || key); // 词典未就绪时的兜底
          return fmtText(s, vars);
        };
      }

      var slots = ctx.slots;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        return; // 无 slots（headless），设置页不可用
      }
      slots.inject("settings.section", function () {
        return slots.register(
          {
            name: "settings.section",
            id: name,
            order: 2,
            label: function () { return translate("section"); },
            inject: function () { return { rpcCall: rpcCall, t: translate }; },
          },
          PortShareSettingsTab,
        );
      });
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  },
});
