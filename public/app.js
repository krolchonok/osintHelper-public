(function () {
  const appEl = document.getElementById("app");
  const navEl = document.getElementById("topbar-nav");
  const UI_SETTINGS_KEY = "ui-settings-v2";

  function readInitialUi() {
    const defaultSettings = { theme: 'dark', effects: false };
    try {
      const stored = window.localStorage.getItem(UI_SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          theme: (parsed.theme === 'dark' || parsed.theme === 'bright') ? parsed.theme : 'dark',
          effects: typeof parsed.effects === 'boolean' ? parsed.effects : true
        };
      }
    } catch (e) {
      // ignore
    }
    return defaultSettings;
  }

  const state = {
    user: null,
    pageCleanup: null,
    projectSearch: "",
    projectsFilterRenderer: null,
    projectSearchDebounceTimer: null,
    ui: readInitialUi(),
  };

  const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);
  const SUBDOMAINS_PAGE_SIZES = [100, 250, 500];
  const DEFAULT_SUBDOMAINS_PAGE_SIZE = SUBDOMAINS_PAGE_SIZES[0];
  const DEBOUNCE_FAST_MS = 120;
  const ICON_EDIT = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
    </svg>
  `;
  const ICON_DELETE = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
    </svg>
  `;
  const ICON_EYE = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  const ICON_EYE_OFF = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M17.94 17.94A10.947 10.947 0 0 1 12 20C5 20 1 12 1 12a21.8 21.8 0 0 1 5.06-5.94"></path>
      <path d="M9.9 4.24A10.946 10.946 0 0 1 12 4c7 0 11 8 11 8a21.79 21.79 0 0 1-3.06 4.24"></path>
      <path d="M14.12 14.12a3 3 0 0 1-4.24-4.24"></path>
      <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>
  `;
  const ICON_SUN = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    </svg>
  `;
  const ICON_MOON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
    </svg>
  `;

  function normalizeSubdomainsPageSize(raw) {
    const value = Number.parseInt(String(raw || ""), 10);
    if (!SUBDOMAINS_PAGE_SIZES.includes(value)) {
      return DEFAULT_SUBDOMAINS_PAGE_SIZE;
    }
    return value;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizePath(pathname) {
    if (!pathname) {
      return "/";
    }

    const trimmed = pathname.replace(/\/+$/, "");
    return trimmed || "/";
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    const time = Date.parse(value);
    if (Number.isNaN(time)) {
      return String(value);
    }

    return new Date(time).toLocaleString();
  }

  function formatTime(value) {
    if (!value) {
      return "-";
    }

    const time = Date.parse(value);
    if (Number.isNaN(time)) {
      return String(value);
    }

    return new Date(time).toLocaleTimeString();
  }

  function closestAction(target, action) {
    return target && typeof target.closest === "function"
      ? target.closest(`[data-action='${action}']`)
      : null;
  }

  function applyUi(options = {}) {
    const { theme, effects } = state.ui;

    document.body.classList.toggle("ui-theme-dark", theme === "dark");
    document.body.classList.toggle("ui-theme-bright", theme === "bright");
    document.body.classList.toggle("ui-effects-enabled", effects);
    document.body.classList.toggle("ui-effects-disabled", !effects);

    if (!options.skipPersist) {
      try {
        window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(state.ui));
      } catch (e) {
        // ignore
      }
    }

    const themeBtn = document.getElementById("ui-theme-toggle-btn");
    if (themeBtn) {
      themeBtn.innerHTML = theme === "dark" ? ICON_SUN : ICON_MOON;
      const label = theme === "dark" ? "Переключить на светлую тему" : "Переключить на темную тему";
      themeBtn.setAttribute("aria-label", label);
      themeBtn.setAttribute("title", label);
    }

    const effectsBtn = document.getElementById("ui-effects-toggle-btn");
    if (effectsBtn) {
      effectsBtn.innerHTML = effects ? ICON_EYE_OFF : ICON_EYE;
      const label = effects ? "Выключить эффекты" : "Включить эффекты";
      effectsBtn.setAttribute("aria-label", label);
      effectsBtn.setAttribute("title", label);
      effectsBtn.setAttribute("aria-pressed", effects ? "true" : "false");
    }

    if (options.notify) {
      const themeLabel = theme === "dark" ? "Темная тема" : "Светлая тема";
      const effectsLabel = effects ? "эффекты включены" : "эффекты выключены";
      showPopup(`${themeLabel}, ${effectsLabel}`, "info", { timeoutMs: 2200 });
    }
  }

  function toggleTheme() {
    state.ui.theme = state.ui.theme === "dark" ? "bright" : "dark";
    applyUi({ notify: true });
  }

  function toggleEffects() {
    state.ui.effects = !state.ui.effects;
    applyUi({ notify: true });
  }

  function buildThemeToggleButton() {
    const theme = state.ui.theme;
    const label = theme === "dark" ? "Переключить на светлую тему" : "Переключить на темную тему";
    const icon = theme === "dark" ? ICON_SUN : ICON_MOON;
    return `<button type="button" id="ui-theme-toggle-btn" class="ui-mode-toggle" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}<span class="visually-hidden">${escapeHtml(label)}</span></button>`;
  }

  function buildEffectsToggleButton() {
    const effects = state.ui.effects;
    const label = effects ? "Выключить эффекты" : "Включить эффекты";
    const icon = effects ? ICON_EYE_OFF : ICON_EYE;
    return `<button type="button" id="ui-effects-toggle-btn" class="ui-mode-toggle" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-pressed="${effects ? "true" : "false"}">${icon}<span class="visually-hidden">${escapeHtml(label)}</span></button>`;
  }

  function setupTopbarUiListeners() {
    const themeBtn = document.getElementById("ui-theme-toggle-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", toggleTheme);
    }
    const effectsBtn = document.getElementById("ui-effects-toggle-btn");
    if (effectsBtn) {
      effectsBtn.addEventListener("click", toggleEffects);
    }
  }

  function ensurePopupRoot() {
    let root = document.getElementById("app-popup-root");
    if (root) {
      return root;
    }

    root = document.createElement("div");
    root.id = "app-popup-root";
    root.className = "app-popup-root";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "false");
    document.body.appendChild(root);
    return root;
  }

  function showPopup(message, kind = "info", options = {}) {
    const text = String(message || "").trim();
    if (!text) {
      return;
    }

    const normalizedKind =
      kind === "error" ? "error" : kind === "success" ? "success" : "info";
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : normalizedKind === "error"
        ? 5600
        : 3600;

    const root = ensurePopupRoot();
    const popup = document.createElement("div");
    popup.className = `app-popup app-popup-${normalizedKind}`;
    popup.innerHTML = `
      <div class="app-popup-text">${escapeHtml(text)}</div>
      <button type="button" class="app-popup-close" aria-label="Закрыть уведомление">×</button>
    `;

    const close = () => {
      if (!popup.isConnected || popup.dataset.closing === "1") {
        return;
      }
      popup.dataset.closing = "1";
      popup.classList.add("is-closing");
      setTimeout(() => {
        if (popup.isConnected) {
          popup.remove();
        }
      }, 180);
    };

    const closeTimer = setTimeout(close, timeoutMs);
    const closeBtn = popup.querySelector(".app-popup-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        clearTimeout(closeTimer);
        close();
      });
    }

    root.appendChild(popup);

    while (root.children.length > 5) {
      root.removeChild(root.firstElementChild);
    }
  }

  function downloadTextFile(filename, content, mimeType = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function csvList(value) {
    return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "").join(", ") : "";
  }

  function downloadCsvFile(filename, headers, rows) {
    const csvRows = [
      headers.map(csvCell).join(";"),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(";")),
    ];
    downloadTextFile(filename, `\uFEFF${csvRows.join("\n")}\n`, "text/csv;charset=utf-8");
  }

  function friendlyError(error, fallback) {
    if (!error) {
      return fallback;
    }

    if (error.payload && typeof error.payload.error === "string") {
      return error.payload.error;
    }

    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }

    return fallback;
  }

  function formatPassiveSourceLabel(sourceId) {
    const value = String(sourceId || "").trim();
    if (!value) {
      return "-";
    }
    return value
      .split("-")
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(" ");
  }

  function formatProjectDomains(project) {
    const domains = Array.isArray(project && project.domains) ? project.domains : [];
    if (domains.length) {
      return domains;
    }
    if (project && project.domain) {
      return [project.domain];
    }
    return [];
  }

  function getProjectDisplayName(project) {
    return String(
      (project && (project.name || project.primaryDomain || project.domain || project.id)) || "Проект",
    );
  }

  function getProjectFileStem(project) {
    return getProjectDisplayName(project)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  }

  function buildWhoisText(whois) {
    if (!whois) {
      return "";
    }

    const lines = [
      `Домен: ${whois.domain || "-"}`,
      `Регистратор: ${whois.registrar || "-"}`,
      `ИНН: ${whois.inn || "-"}`,
      `Владелец: ${whois.registrant || "-"}`,
      `Страна: ${whois.country || "-"}`,
      `Создан: ${whois.createdAt || "-"}`,
      `Обновлен: ${whois.updatedAt || "-"}`,
      `Истекает: ${whois.expiresAt || "-"}`,
      `DNSSEC: ${whois.dnssec || "-"}`,
      `Почта: ${Array.isArray(whois.emails) && whois.emails.length ? whois.emails.join(", ") : "-"}`,
      `Статус: ${Array.isArray(whois.status) && whois.status.length ? whois.status.join(", ") : "-"}`,
      `NS: ${Array.isArray(whois.nameservers) && whois.nameservers.length ? whois.nameservers.join(", ") : "-"}`,
      `Источник: ${whois.source || whois.rdapUrl || "-"}`,
      `Кэшировано: ${whois.cachedAt || "-"}`,
    ];
    return lines.join("\n");
  }

  function formatProviderCheckMessage(providerId, result) {
    const summary = result && result.summary ? String(result.summary) : "Проверка завершена";
    const limit =
      result && Object.prototype.hasOwnProperty.call(result, "limit") && result.limit !== null
        ? `лимит=${result.limit}`
        : "лимит=?";
    const remaining =
      result && Object.prototype.hasOwnProperty.call(result, "remaining") && result.remaining !== null
        ? `остаток=${result.remaining}`
        : "остаток=?";

    return `${summary} (${limit}, ${remaining})`;
  }

  function buildIntelxQuotaMarkup(result) {
    const accounts = Array.isArray(result && result.details) ? result.details : [];
    if (!accounts.length) {
      return "";
    }

    const totalAvailable = Number(result && result.remaining) || 0;
    const totalMax = Number(result && result.limit) || 0;
    const totalPercent = totalMax > 0
      ? Math.max(0, Math.min(100, Math.round((totalAvailable / totalMax) * 100)))
      : 0;

    const rows = accounts
      .map((item, index) => {
        const available = Number(item && item.available) || 0;
        const creditMax = Number(item && item.creditMax) || 0;
        const percent = creditMax > 0
          ? Math.max(0, Math.min(100, Math.round((available / creditMax) * 100)))
          : 0;

        return `
          <div class="intelx-quota-card">
            <div class="progress-meta">
              <span>Key ${index + 1}</span>
              <span>${available}/${creditMax || "?"}</span>
            </div>
            <div class="progress-track"><div class="progress-fill intelx-progress-fill" style="width:${percent}%"></div></div>
          </div>
        `;
      })
      .join("");

    return `
      <div class="intelx-quota-grid">
        <div class="intelx-quota-card intelx-quota-card-total">
          <div class="progress-meta">
            <span>Общий остаток</span>
            <span>${totalAvailable}/${totalMax || "?"}</span>
          </div>
          <div class="progress-track"><div class="progress-fill intelx-progress-fill" style="width:${totalPercent}%"></div></div>
        </div>
        ${rows}
      </div>
    `;
  }

  function setPageCleanup(cleanup) {
    if (typeof state.pageCleanup === "function") {
      try {
        state.pageCleanup();
      } catch {
        // ignore cleanup failures
      }
    }

    state.pageCleanup = typeof cleanup === "function" ? cleanup : null;
  }

  function navigate(path, options) {
    const replace = Boolean(options && options.replace);
    if (replace) {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }

    void renderRoute();
  }

  async function api(path, options) {
    const request = {
      method: (options && options.method) || "GET",
      credentials: "same-origin",
      headers: {
        ...(options && options.headers ? options.headers : {}),
      },
    };

    if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
      if (
        options.body !== null &&
        typeof options.body === "object" &&
        !(options.body instanceof FormData)
      ) {
        request.body = JSON.stringify(options.body);
        request.headers["Content-Type"] = "application/json";
      } else {
        request.body = options.body;
      }
    }

    const response = await fetch(path, request);
    const text = await response.text();

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const error = new Error((payload && payload.error) || `Ошибка запроса (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function loadCurrentUser() {
    try {
      const payload = await api("/api/auth/me");
      if (payload && payload.authenticated && payload.user) {
        state.user = payload.user;
      } else {
        state.user = null;
      }
    } catch {
      state.user = null;
    }
  }

  function renderTopbar() {
    if (state.projectSearchDebounceTimer) {
      clearTimeout(state.projectSearchDebounceTimer);
      state.projectSearchDebounceTimer = null;
    }

    const themeBtnMarkup = buildThemeToggleButton();
    const effectsBtnMarkup = buildEffectsToggleButton();

    if (!state.user) {
      navEl.innerHTML = [themeBtnMarkup, effectsBtnMarkup, '<a href="/login" data-link>Вход</a>'].join("");
      setupTopbarUiListeners();
      return;
    }

    const searchValue = escapeHtml(state.projectSearch || "");
    const adminLinks =
      state.user.role === "ADMIN"
        ? '<a href="/settings" data-link>Провайдеры</a><a href="/admin" data-link>Админка</a>'
        : "";

    navEl.innerHTML = [
      themeBtnMarkup,
      effectsBtnMarkup,
      '<a href="/" data-link>Проекты</a>',
      adminLinks,
      `<input id="topbar-search" class="text-input topbar-search" type="search" placeholder="Поиск проектов..." aria-label="Поиск проектов" value="${searchValue}" />`,
      `<span class="session-user mono">${escapeHtml(state.user.email)}</span>`,
      `<span class="pill tiny">${escapeHtml(state.user.role)}</span>`,
      '<button type="button" id="logout-btn">Выход</button>',
    ].join("");

    setupTopbarUiListeners();

    const logoutButton = document.getElementById("logout-btn");
    if (logoutButton) {
      logoutButton.addEventListener("click", async () => {
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch {
          // ignore logout API failure and force local redirect
        }

        state.user = null;
        renderTopbar();
        navigate("/login", { replace: true });
      });
    }

    const searchInput = document.getElementById("topbar-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        if (state.projectSearchDebounceTimer) {
          clearTimeout(state.projectSearchDebounceTimer);
        }

        state.projectSearchDebounceTimer = setTimeout(() => {
          state.projectSearchDebounceTimer = null;
          state.projectSearch = searchInput.value.trim();

          if (normalizePath(window.location.pathname) !== "/") {
            return;
          }

          if (typeof state.projectsFilterRenderer === "function") {
            state.projectsFilterRenderer();
            return;
          }

          void renderProjectsPage();
        }, 120);
      });
    }
  }

  function renderLoading(label) {
    appEl.innerHTML = `<div class="panel loading">${escapeHtml(label || "Загрузка...")}</div>`;
  }

  function renderErrorBanner(message, options = {}) {
    if (!options || options.popup !== false) {
      showPopup(message, "error");
    }
    return `<div class="error-banner">${escapeHtml(message)}</div>`;
  }

  function renderSuccessBanner(message, options = {}) {
    if (!options || options.popup !== false) {
      showPopup(message, "success");
    }
    return `<div class="success-banner">${escapeHtml(message)}</div>`;
  }

  async function renderLoginPage() {
    let setupStatus = null;
    try {
      setupStatus = await api("/api/setup/status");
    } catch {
      setupStatus = { initialized: true };
    }

    const setupMessage =
      setupStatus && setupStatus.initialized === false
        ? '<p class="hint">Система еще не инициализирована. Откройте ссылку setup из логов сервера или используйте <a href="/setup" data-link>/setup</a>.</p>'
        : "";

    appEl.innerHTML = `
      <div class="stack-xl auth-page">
        <section class="panel hero auth-card">
          <h1>Вход</h1>
          <p>Используйте аккаунт для доступа к панели разведки.</p>
        </section>

        <section class="panel auth-card">
          <form id="login-form">
            <div id="login-message"></div>
            <div class="field">
              <label for="login-email">Почта</label>
              <input id="login-email" class="text-input" type="email" required />
            </div>
            <div class="field">
              <label for="login-password">Пароль</label>
              <input id="login-password" class="text-input" type="password" required />
            </div>
            <div class="row">
              <button class="btn btn-primary" type="submit" id="login-submit">Войти</button>
            </div>
          </form>
          ${setupMessage}
        </section>
      </div>
    `;

    const form = document.getElementById("login-form");
    const submit = document.getElementById("login-submit");
    const messageEl = document.getElementById("login-message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;

      submit.disabled = true;
      messageEl.innerHTML = "";

      try {
        await api("/api/auth/login", {
          method: "POST",
          body: { email, password },
        });

        await loadCurrentUser();
        renderTopbar();
        navigate("/", { replace: true });
      } catch (error) {
        messageEl.innerHTML = renderErrorBanner(
          friendlyError(error, "Не удалось войти"),
        );
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function renderSetupPage() {
    const query = new URLSearchParams(window.location.search);
    const tokenParam = query.get("token") || "";

    let setupStatus;
    try {
      setupStatus = await api("/api/setup/status");
    } catch (error) {
      appEl.innerHTML = `
        <div class="stack-xl auth-page">
          <section class="panel auth-card">${renderErrorBanner(
            friendlyError(error, "Не удалось загрузить статус настройки"),
          )}</section>
        </div>
      `;
      return;
    }

    if (setupStatus && setupStatus.initialized) {
      appEl.innerHTML = `
        <div class="stack-xl auth-page">
          <section class="panel hero auth-card">
            <h1>Уже инициализировано</h1>
            <p>Корневой администратор уже создан. Используйте обычный вход.</p>
            <div class="row">
              <a class="btn btn-primary" href="/login" data-link>Перейти ко входу</a>
            </div>
          </section>
        </div>
      `;
      return;
    }

    appEl.innerHTML = `
      <div class="stack-xl auth-page">
        <section class="panel hero auth-card">
          <h1>Первичная настройка системы</h1>
          <p>Создайте корневого администратора по одноразовому токену.</p>
        </section>

        <section class="panel auth-card">
          <form id="setup-form">
            <div id="setup-message"></div>
            <div class="field">
              <label for="setup-token">Токен настройки</label>
              <input id="setup-token" class="text-input mono" type="text" required value="${escapeHtml(
                tokenParam,
              )}" />
            </div>
            <div class="field">
              <label for="setup-email">Почта администратора</label>
              <input id="setup-email" class="text-input" type="email" required />
            </div>
            <div class="field">
              <label for="setup-password">Пароль администратора</label>
              <input id="setup-password" class="text-input" type="password" minlength="8" required />
            </div>
            <div class="row">
              <button class="btn btn-primary" id="setup-submit" type="submit">Создать администратора</button>
            </div>
          </form>
          <p class="hint">Токен появляется в логах запуска (<span class="mono">[auth:init-admin] setup URL</span>).</p>
        </section>
      </div>
    `;

    const form = document.getElementById("setup-form");
    const submit = document.getElementById("setup-submit");
    const messageEl = document.getElementById("setup-message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const token = document.getElementById("setup-token").value.trim();
      const email = document.getElementById("setup-email").value.trim();
      const password = document.getElementById("setup-password").value;

      submit.disabled = true;
      messageEl.innerHTML = "";

      try {
        await api("/api/auth/setup", {
          method: "POST",
          body: { token, email, password },
        });

        await loadCurrentUser();
        renderTopbar();
        navigate("/", { replace: true });
      } catch (error) {
        messageEl.innerHTML = renderErrorBanner(
          friendlyError(error, "Не удалось выполнить настройку"),
        );
      } finally {
        submit.disabled = false;
      }
    });
  }

  function renderProjectsList(projects) {
    if (!projects.length) {
      return '<p class="hint">По текущему запросу проекты не найдены.</p>';
    }

    const cards = projects
      .map((project, index) => {
        const lastRun = project.lastRun;
        const status = lastRun
          ? `${escapeHtml(lastRun.type)} · ${escapeHtml(lastRun.status)}`
          : "Нет запусков";
        const subdomainsCount = Number(project.counts && project.counts.subdomains) || 0;
        const runsCount = Number(project.counts && project.counts.runs) || 0;
        const reviewMinutes = Math.max(1, Math.ceil(subdomainsCount / 220));
        const createdAt = formatDate(project.createdAt);
        const domains = formatProjectDomains(project);
        const projectName = getProjectDisplayName(project);
        const lead = domains.length
          ? `Покрытие для ${projectName}: пассивные источники, DNS-резолв и история запусков.`
          : `Проект ${projectName} готов к наполнению доменами, сканами и сохранёнными результатами.`;
        const domainsMeta = domains.length > 1
          ? `${domains.length} домена: ${domains.join(", ")}`
          : `${domains[0] || "Домен пока не добавлен"}`;

        return `
          <a class="project-card" href="/projects/${encodeURIComponent(project.id)}" data-link style="--card-stagger:${40 + ((index % 8) * 40)}ms">
            <div class="project-card-main">
              <div class="meta">
                <span>${escapeHtml(createdAt)}</span>
                <span class="pill tiny">${status}</span>
              </div>
              <div class="project-title mono">${escapeHtml(projectName)}</div>
              <div class="project-lead">${escapeHtml(lead)}</div>
              <div class="hint mono">${escapeHtml(domainsMeta)}</div>
              <div class="project-insight">
                ${subdomainsCount} активов • ${runsCount} запусков • ${reviewMinutes} мин на просмотр
              </div>
            </div>
            <div class="project-preview" aria-hidden="true"></div>
          </a>
        `;
      })
      .join("");

    return `<div class="project-grid">${cards}</div>`;
  }

  async function renderProjectsPage() {
    let payload;

    try {
      payload = await api("/api/projects");
    } catch (error) {
      appEl.innerHTML = `
        <section class="panel">${renderErrorBanner(
          friendlyError(error, "Не удалось загрузить проекты"),
        )}</section>
      `;
      return;
    }

    const allProjects = Array.isArray(payload && payload.projects) ? payload.projects : [];

    appEl.innerHTML = `
      <div class="stack-xl">
        <section class="hero panel">
          <h1>Passive Recon Management</h1>
          <p>Создавайте проект по названию, добавляйте домены внутри и запускайте сканы с сохранением результатов.</p>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Новый проект</h2>
            <p>Домен можно добавить позже уже внутри проекта.</p>
          </div>
          <form id="project-create-form">
            <div id="project-create-message"></div>
            <input id="project-create-input" class="text-input" type="text" placeholder="Название проекта" />
            <div class="row">
              <button class="btn btn-primary" id="project-create-submit" type="submit">Создать проект</button>
            </div>
          </form>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Проекты</h2>
            <p id="projects-count-text"></p>
          </div>
          <div id="projects-list-root"></div>
        </section>
      </div>
    `;

    const projectsCountEl = document.getElementById("projects-count-text");
    const projectsListRoot = document.getElementById("projects-list-root");

    function applyProjectsFilter() {
      const searchNeedle = String(state.projectSearch || "").trim().toLowerCase();
      const projects = searchNeedle
        ? allProjects.filter((project) => {
            const domainsMatch = formatProjectDomains(project)
              .some((domain) => String(domain || "").toLowerCase().includes(searchNeedle));
            const nameMatch = getProjectDisplayName(project).toLowerCase().includes(searchNeedle);
            return domainsMatch || nameMatch;
          })
        : allProjects;

      if (projectsCountEl) {
        projectsCountEl.textContent = `${projects.length}${searchNeedle ? ` / ${allProjects.length}` : ""} проектов`;
      }
      if (projectsListRoot) {
        projectsListRoot.innerHTML = renderProjectsList(projects);
      }
    }

    state.projectsFilterRenderer = applyProjectsFilter;
    applyProjectsFilter();

    const form = document.getElementById("project-create-form");
    const submit = document.getElementById("project-create-submit");
    const messageEl = document.getElementById("project-create-message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = document.getElementById("project-create-input").value.trim();

      if (!name) {
        messageEl.innerHTML = renderErrorBanner("Название проекта обязательно");
        return;
      }

      submit.disabled = true;
      messageEl.innerHTML = "";

      try {
        const result = await api("/api/projects", {
          method: "POST",
          body: { name },
        });

        messageEl.innerHTML = renderSuccessBanner(
          `Проект "${getProjectDisplayName(result.project)}" создан`,
        );

        await renderProjectsPage();
      } catch (error) {
        messageEl.innerHTML = renderErrorBanner(
          friendlyError(error, "Не удалось сохранить проекты"),
        );
      } finally {
        submit.disabled = false;
      }
    });

    setPageCleanup(() => {
      state.projectsFilterRenderer = null;
    });
  }

  function buildRunsTable(runs, selectedRunId) {
    if (!runs.length) {
      return '<p class="hint">Запусков пока нет.</p>';
    }

    const rows = runs
      .map((run) => {
        const progress = Math.max(0, Math.min(100, Number(run.progress) || 0));
        const selected = selectedRunId === run.id;
        const runTypeLabel =
          run.taskKind === "WHOIS"
            ? "WHOIS"
            : run.taskKind === "VT_DEEP"
              ? "VT_DEEP"
              : run.taskKind === "WEBARCHIVE"
                ? "WEBARCHIVE"
              : run.taskKind === "DORK_STATS"
                ? "DORK_STATS"
              : run.taskKind === "INTELX_LEAKS"
                ? "INTELX_LEAKS"
              : run.taskKind === "DNS_RESOLVE_SELECTED"
                ? "DNS_RESOLVE_SELECTED"
              : run.type;
        const scopeLabel =
          run.taskKind === "WHOIS" ||
          run.taskKind === "VT_DEEP" ||
          run.taskKind === "WEBARCHIVE" ||
          run.taskKind === "DORK_STATS" ||
          run.taskKind === "INTELX_LEAKS" ||
          run.taskKind === "DNS_RESOLVE_SELECTED"
            ? "-"
            : run.type === "DNS_RESOLVE"
            ? (run.scanScope === "core" ? "fast" : "extended")
            : ((run.scanScope || "core") === "core" ? "base" : (run.scanScope || "core"));
        const canCancel =
          (run.status === "QUEUED" || run.status === "RUNNING") &&
          !Boolean(run.cancelRequested);

        return `
          <tr>
            <td>${escapeHtml(runTypeLabel)} <span class="pill tiny">${escapeHtml(scopeLabel)}</span></td>
            <td>${escapeHtml(run.status)}</td>
            <td>
              <div class="progress-meta">
                <span>${progress}%</span>
                <span>${
                  Number(run.processed) > 0 || Number(run.total) > 0
                    ? `${Number(run.processed) || 0}/${Number(run.total) || "?"}`
                    : "-"
                }</span>
              </div>
              <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
            </td>
            <td>${escapeHtml(run.stage || "-")}</td>
            <td>${escapeHtml(formatDate(run.startedAt))}</td>
            <td>${escapeHtml(formatDate(run.finishedAt))}</td>
            <td class="error-cell">${escapeHtml(run.error || "-")}</td>
            <td>
              <button class="btn ${selected ? "btn-primary" : "btn-ghost"}" data-run-id="${escapeHtml(
                run.id,
              )}" data-action="select-run">
                ${selected ? "Выбрано" : "Показать лог"}
              </button>
              ${
                canCancel
                  ? `<button class="btn btn-danger" data-run-id="${escapeHtml(run.id)}" data-action="cancel-run">Отменить</button>`
                  : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Тип</th>
              <th>Статус</th>
              <th>Прогресс</th>
              <th>Этап</th>
              <th>Старт</th>
              <th>Завершен</th>
              <th>Ошибка</th>
              <th>Лог</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function pickTimelineRun(runs, selectedRunId) {
    if (!runs.length) {
      return null;
    }
    return (
      runs.find((run) => run.id === selectedRunId) ||
      runs.find((run) => ACTIVE_STATUSES.has(run.status)) ||
      runs[0] ||
      null
    );
  }

  function formatRunTypeLabel(run) {
    if (!run) {
      return "-";
    }
    if (run.taskKind === "WHOIS") {
      return "WHOIS";
    }
    if (run.taskKind === "VT_DEEP") {
      return "VT_DEEP";
    }
    if (run.taskKind === "WEBARCHIVE") {
      return "WEBARCHIVE";
    }
    if (run.taskKind === "INTELX_LEAKS") {
      return "INTELX_LEAKS";
    }
    if (run.taskKind === "DNS_RESOLVE_SELECTED") {
      return "DNS_RESOLVE_SELECTED";
    }
    return run.type || "-";
  }

  function buildRunTimelineRows(selectedRun) {
    if (!selectedRun || !Array.isArray(selectedRun.events) || selectedRun.events.length === 0) {
      return [];
    }

    return selectedRun.events.map(
      (event) => `
        <li class="timeline-item">
          <div class="timeline-head">
            <span class="pill">${Number(event.progress) || 0}%</span>
            <span class="mono">${escapeHtml(formatTime(event.createdAt))}</span>
          </div>
          <div class="timeline-stage">${escapeHtml(event.stage || "-")}</div>
          ${
            Number(event.processed) > 0 || Number(event.total) > 0
              ? `<div class="hint">${Number(event.processed) || 0}/${Number(event.total) || "?"}</div>`
              : ""
          }
        </li>
      `,
    );
  }

  function buildRunTimelineFallback(runs, selectedRunId) {
    const selectedRun = pickTimelineRun(runs, selectedRunId);
    if (!selectedRun) {
      return '<p class="hint">Нет данных таймлайна.</p>';
    }

    const rows = buildRunTimelineRows(selectedRun);
    if (!rows.length) {
      return '<p class="hint">Событий пока нет.</p>';
    }

    return `
      <div class="panel-header">
        <h3>Таймлайн запуска</h3>
        <p>${escapeHtml(formatRunTypeLabel(selectedRun))} · ${escapeHtml(selectedRun.status)}</p>
      </div>
      <div class="timeline-scroll"><ol class="timeline">${rows.join("")}</ol></div>
    `;
  }

  function buildSubdomainsTable(subdomains, pagination = {}, selectedSubdomainIds = new Set()) {
    const total = Math.max(0, Number(pagination.total) || 0);
    const pageSize = normalizeSubdomainsPageSize(pagination.limit);
    const totalPages = Math.max(
      1,
      Number(pagination.totalPages) || Math.ceil(total / Math.max(pageSize, 1)) || 1,
    );
    const currentPage = Math.max(1, Math.min(totalPages, Number(pagination.page) || 1));
    const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const end = total === 0 ? 0 : Math.min(total, (currentPage - 1) * pageSize + subdomains.length);
    const allVisibleSelected =
      subdomains.length > 0 &&
      subdomains.every((subdomain) => selectedSubdomainIds.has(String(subdomain.id)));
    const pageSizeOptions = SUBDOMAINS_PAGE_SIZES
      .map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size}</option>`)
      .join("");

    if (!subdomains.length) {
      return `
        <div class="row wrap subdomains-table-toolbar">
          <span class="hint">Показано ${start}-${end} из ${total}</span>
          <label class="hint subdomains-page-size-label">На странице
            <select class="text-input mono" data-action="subdomains-page-size">${pageSizeOptions}</select>
          </label>
          <button class="btn btn-ghost" data-action="subdomains-prev-page" ${currentPage <= 1 ? "disabled" : ""}>Назад</button>
          <button class="btn btn-ghost" data-action="subdomains-next-page" ${currentPage >= totalPages ? "disabled" : ""}>Далее</button>
          <span class="pill tiny">Страница ${currentPage}/${totalPages}</span>
        </div>
        <p class="hint">${total > 0 ? "На этой странице нет строк." : "Поддомены еще не сохранены."}</p>
      `;
    }

    const rows = subdomains
      .map((subdomain) => {
        const sourceText = Array.isArray(subdomain.sources) && subdomain.sources.length
          ? subdomain.sources.map((item) => item.source).join(", ")
          : "-";

        const ips = Array.from(
          new Set(
            (subdomain.dnsRecords || [])
              .filter((record) => record.recordType === "A" || record.recordType === "AAAA")
              .map((record) => record.value),
          ),
        );

        return `
          <tr>
            <td>
              <input
                type="checkbox"
                data-action="toggle-subdomain-select"
                data-subdomain-id="${escapeHtml(subdomain.id)}"
                ${selectedSubdomainIds.has(String(subdomain.id)) ? "checked" : ""}
              />
            </td>
            <td>
              <span class="mono">${escapeHtml(subdomain.host)}</span>
              ${subdomain.isRoot ? '<span class="pill tiny">корень</span>' : ""}
            </td>
            <td>${escapeHtml(sourceText)}</td>
            <td>${escapeHtml(ips.length ? ips.join(", ") : "-")}</td>
            <td>
              ${
                subdomain.isRoot
                  ? '<span class="hint">Заблокирован</span>'
                  : `
                    <div class="subdomain-actions">
                      <button
                        class="btn btn-ghost btn-icon"
                        data-action="edit-subdomain"
                        data-subdomain-id="${escapeHtml(subdomain.id)}"
                        data-host="${escapeHtml(subdomain.host)}"
                        aria-label="Изменить поддомен"
                        title="Изменить"
                        type="button"
                      >${ICON_EDIT}</button>
                      <button
                        class="btn btn-danger btn-icon"
                        data-action="delete-subdomain"
                        data-subdomain-id="${escapeHtml(subdomain.id)}"
                        aria-label="Удалить поддомен"
                        title="Удалить"
                        type="button"
                      >${ICON_DELETE}</button>
                    </div>
                  `
              }
            </td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="row wrap subdomains-table-toolbar">
        <span class="hint">Показано ${start}-${end} из ${total}</span>
        <label class="hint subdomains-page-size-label">На странице
          <select class="text-input mono" data-action="subdomains-page-size">${pageSizeOptions}</select>
        </label>
        <button class="btn btn-ghost" data-action="subdomains-prev-page" ${currentPage <= 1 ? "disabled" : ""}>Назад</button>
        <button class="btn btn-ghost" data-action="subdomains-next-page" ${currentPage >= totalPages ? "disabled" : ""}>Далее</button>
        <span class="pill tiny">Страница ${currentPage}/${totalPages}</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" data-action="subdomains-select-all" ${allVisibleSelected ? "checked" : ""} />
              </th>
              <th>Хост</th>
              <th>Источники</th>
              <th>IP (A/AAAA)</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function buildVtDeepTable(vtData) {
    if (!vtData) {
      return '<p class="hint">Данные еще не загружены.</p>';
    }

    const files = Array.isArray(vtData.files) ? vtData.files : [];
    if (!files.length) {
      return '<p class="hint">Связанные файлы не найдены.</p>';
    }

    const rows = files
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.relationship || "-")}</td>
            <td class="mono">${escapeHtml(item.name || "-")}</td>
            <td class="mono">${escapeHtml(item.sha256 || item.id || "-")}</td>
            <td>${item.positives != null && item.total ? `${item.positives}/${item.total}` : "-"}</td>
            <td>${escapeHtml(formatDate(item.lastSeen))}</td>
            <td><a href="${escapeHtml(item.vtLink || "#")}" target="_blank" rel="noopener noreferrer">Открыть</a></td>
          </tr>
        `,
      )
      .join("");

    const stats = vtData.stats || {};
    const statsText = Object.keys(stats).length
      ? Object.entries(stats)
          .map(([key, value]) => `${key}: ${value}`)
          .join(" · ")
      : "Нет статистики";

    return `
      <div class="panel-header">
        <h3>VirusTotal Deep</h3>
        <p>${escapeHtml(statsText)} · Загружено: ${escapeHtml(formatDate(vtData.loadedAt))}</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Связь</th>
              <th>Файл</th>
              <th>Хеш</th>
              <th>Детекты</th>
              <th>Последний раз замечен</th>
              <th>Ссылка</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function buildIntelxTable(intelxData, projectId = "", selectedHitKeys = new Set()) {
    if (!intelxData) {
      return '<p class="hint">Данные IntelX еще не загружены. Запустите задачу IntelX, чтобы сохранить результаты в проект.</p>';
    }

    const searches = Array.isArray(intelxData.searches) ? intelxData.searches : [];
    if (!searches.length) {
      return '<p class="hint">Поиск IntelX еще не запускался.</p>';
    }

    const sections = searches
      .map((entry, searchIndex) => {
        const hits = Array.isArray(entry.hits) ? entry.hits : [];
        const rows = hits.length
          ? hits
              .map(
                (hit, hitIndex) => {
                  const hitKey = `${searchIndex}:${hitIndex}`;
                  const storageid = String(hit.storageid || "").trim();
                  const bucket = String(hit.bucket || "leaks.public.general").trim() || "leaks.public.general";
                  const fileUrl = storageid
                    ? `/api/projects/${encodeURIComponent(projectId || "")}/intelx-file?storageid=${encodeURIComponent(storageid)}&bucket=${encodeURIComponent(bucket)}`
                    : "";
                  const fileName = formatIntelxFileName(hit);
                  const fileLink = fileUrl
                    ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fileName)}</a>`
                    : escapeHtml(fileName);
                  return `
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        data-action="toggle-intelx-hit-select"
                        data-hit-key="${escapeHtml(hitKey)}"
                        ${selectedHitKeys.has(hitKey) ? "checked" : ""}
                      />
                    </td>
                    <td class="mono">${escapeHtml(entry.term || "-")}</td>
                    <td>
                      <div class="intelx-hit-file">${fileLink}</div>
                      <div class="intelx-hit-line mono">${escapeHtml(hit.line || "-")}</div>
                    </td>
                    <td>
                      <div class="subdomain-actions">
                        <button
                          class="btn btn-ghost btn-icon"
                          data-action="edit-intelx-hit"
                          data-hit-key="${escapeHtml(hitKey)}"
                          aria-label="Изменить IntelX строку"
                          title="Изменить"
                          type="button"
                        >${ICON_EDIT}</button>
                        <button
                          class="btn btn-danger btn-icon"
                          data-action="delete-intelx-hit"
                          data-hit-key="${escapeHtml(hitKey)}"
                          aria-label="Удалить IntelX строку"
                          title="Удалить"
                          type="button"
                        >${ICON_DELETE}</button>
                      </div>
                    </td>
                  </tr>
                `;
                },
              )
              .join("")
          : `
            <tr>
              <td></td>
              <td class="mono">${escapeHtml(entry.term || "-")}</td>
              <td>Совпадений не найдено</td>
              <td></td>
            </tr>
          `;
        const visibleHitKeys = hits.map((_hit, hitIndex) => `${searchIndex}:${hitIndex}`);
        const allVisibleSelected = visibleHitKeys.length > 0 && visibleHitKeys.every((key) => selectedHitKeys.has(key));

        return `
          <div class="stack-md">
            <div class="row wrap">
              <span class="pill mono">${escapeHtml(entry.term || "-")}</span>
              <span class="hint">${Number(entry.count) || 0} совпадений</span>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        data-action="intelx-select-search"
                        data-search-index="${searchIndex}"
                        ${allVisibleSelected ? "checked" : ""}
                        ${visibleHitKeys.length ? "" : "disabled"}
                      />
                    </th>
                    <th>Терм</th>
                    <th>Файл и найденная строка</th>
                    <th>Действия</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `;
      })
      .join("");

    const summary = intelxData.summary || {};
    const meta = [
      intelxData.querySource === "custom" && intelxData.customQuery
        ? `Кастомный запрос: ${intelxData.customQuery}`
        : "",
      `Поисков: ${Number(summary.searches) || searches.length}`,
      `Совпадений: ${Number(summary.hits) || 0}`,
      intelxData.cachedAt ? `Кэшировано: ${formatDate(intelxData.cachedAt)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return `
      <div class="stack-lg">
        <div class="hint">${escapeHtml(meta || "Результаты IntelX")}</div>
        ${sections}
      </div>
    `;
  }

  function formatIntelxFileName(hit) {
    const explicitName = String(hit?.fileName || "").trim();
    if (explicitName) {
      return explicitName;
    }

    const storageid = String(hit?.storageid || "").trim();
    if (storageid) {
      return `storage:${storageid.slice(0, 12)}...${storageid.slice(-8)}`;
    }

    return "Файл IntelX";
  }

  function buildWebArchiveTable(webarchiveData) {
    if (!webarchiveData) {
      return '<p class="hint">Данные WebArchive еще не загружены. Запустите задачу WebArchive, чтобы сохранить результаты в проект.</p>';
    }

    const summary = webarchiveData.summary || {};
    const metadataSummary = webarchiveData.metadataSummary || {};
    const statCards = [
      { label: "URL", value: Number(summary.totalUrls) || 0 },
      { label: "Снимки", value: Number(summary.totalCaptures) || 0 },
      { label: "Хосты", value: Number(summary.hosts) || 0 },
      { label: "PDF", value: Number(summary.pdf) || 0 },
      { label: "DOC", value: Number(summary.doc) || 0 },
      { label: "DOCX", value: Number(summary.docx) || 0 },
      { label: "Авторы", value: Number(metadataSummary.withAuthor) || 0 },
      { label: "Редакторы", value: Number(metadataSummary.withEditor) || 0 },
      { label: "Почты", value: Number(metadataSummary.withEmails) || 0 },
    ]
      .map(
        (item) => `
          <div class="data-stat-card">
            <div class="data-stat-value mono">${escapeHtml(String(item.value))}</div>
            <div class="data-stat-label">${escapeHtml(item.label)}</div>
          </div>
        `,
      )
      .join("");

    const meta = [
      Array.isArray(webarchiveData.terms) && webarchiveData.terms.length
        ? `Домены: ${webarchiveData.terms.join(", ")}`
        : "",
      summary.earliestCapture ? `Первый снимок: ${formatDate(summary.earliestCapture)}` : "",
      summary.latestCapture ? `Последний снимок: ${formatDate(summary.latestCapture)}` : "",
      metadataSummary.processed ? `Метаданные: ${metadataSummary.processed}` : "",
      metadataSummary.failed ? `Ошибки: ${metadataSummary.failed}` : "",
      webarchiveData.cachedAt ? `Кэшировано: ${formatDate(webarchiveData.cachedAt)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const documents = Array.isArray(webarchiveData.documents) ? webarchiveData.documents : [];
    const recentUrls = Array.isArray(webarchiveData.recentUrls) ? webarchiveData.recentUrls : [];

    const documentRows = documents.length
      ? documents
          .map(
            (item) => {
              const details = [
                item.metadata?.title ? `title: ${item.metadata.title}` : "",
                item.metadata?.subject ? `subject: ${item.metadata.subject}` : "",
                item.metadata?.keywords ? `keywords: ${item.metadata.keywords}` : "",
                item.metadata?.company ? `company: ${item.metadata.company}` : "",
                item.metadata?.manager ? `manager: ${item.metadata.manager}` : "",
                item.metadata?.application ? `app: ${item.metadata.application}` : "",
                item.metadata?.appVersion ? `ver: ${item.metadata.appVersion}` : "",
                item.metadata?.producer ? `producer: ${item.metadata.producer}` : "",
                item.metadata?.revision ? `revision: ${item.metadata.revision}` : "",
                item.metadata?.pages ? `pages: ${item.metadata.pages}` : "",
                item.metadata?.words ? `words: ${item.metadata.words}` : "",
                item.metadata?.characters ? `chars: ${item.metadata.characters}` : "",
                item.metadata?.createdAt ? `created: ${formatDate(item.metadata.createdAt)}` : "",
                item.metadata?.modifiedAt ? `modified: ${formatDate(item.metadata.modifiedAt)}` : "",
              ].filter(Boolean).join(" | ");

              return `
              <tr>
                <td><span class="pill tiny mono">${escapeHtml(String(item.type || "-").toUpperCase())}</span></td>
                <td class="mono">${escapeHtml(item.host || "-")}</td>
                <td class="mono"><a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url || "-")}</a></td>
                <td>${escapeHtml(formatDate(item.capturedAt))}</td>
                <td>${escapeHtml(item.metadata?.author || "-")}</td>
                <td>${escapeHtml(item.metadata?.lastModifiedBy || "-")}</td>
                <td>${escapeHtml(item.metadata?.title || "-")}</td>
                <td>${escapeHtml(item.metadata?.company || item.metadata?.application || item.metadata?.producer || "-")}</td>
                <td>${escapeHtml(Array.isArray(item.metadata?.emails) && item.metadata.emails.length ? item.metadata.emails.join(", ") : "-")}</td>
                <td>${item.length != null ? escapeHtml(String(item.length)) : "-"}</td>
                <td>${escapeHtml(item.metadataStatus || "-")}</td>
                <td class="webarchive-metadata-cell">${escapeHtml(details || "-")}</td>
                <td>${item.archiveUrl ? `<a href="${escapeHtml(item.archiveUrl)}" target="_blank" rel="noopener noreferrer">Wayback</a>` : "-"}</td>
              </tr>
            `;
            },
          )
          .join("")
      : `
        <tr>
          <td colspan="13">Документы PDF/DOC/DOCX не найдены.</td>
        </tr>
      `;

    const recentUrlRows = recentUrls.length
      ? recentUrls
          .map(
            (item) => `
              <tr>
                <td class="mono">${escapeHtml(item.host || "-")}</td>
                <td class="mono"><a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url || "-")}</a></td>
                <td>${escapeHtml(item.mimetype || "-")}</td>
                <td>${escapeHtml(formatDate(item.capturedAt))}</td>
                <td>${item.archiveUrl ? `<a href="${escapeHtml(item.archiveUrl)}" target="_blank" rel="noopener noreferrer">Открыть</a>` : "-"}</td>
              </tr>
            `,
          )
          .join("")
      : `
        <tr>
          <td colspan="5">Архивные URL не найдены.</td>
        </tr>
      `;

    return `
      <div class="stack-lg">
        <div class="hint">${escapeHtml(meta || "Результаты WebArchive")}</div>
        <div class="data-stat-grid">${statCards}</div>
        <div class="stack-md">
          <div class="panel-header">
            <h3>Документы</h3>
            <p>PDF, DOC, DOCX из Wayback</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Хост</th>
                  <th>URL</th>
                  <th>Снимок</th>
                  <th>Автор</th>
                  <th>Редактор</th>
                  <th>Title</th>
                  <th>App/Company</th>
                  <th>Почты</th>
                  <th>Размер</th>
                  <th>Статус</th>
                  <th>Полезные поля</th>
                  <th>Архив</th>
                </tr>
              </thead>
              <tbody>${documentRows}</tbody>
            </table>
          </div>
        </div>
        <div class="stack-md">
          <div class="panel-header">
            <h3>Последние URL</h3>
            <p>Сводка по снимкам Wayback</p>
          </div>
          <div class="table-wrap webarchive-recent-urls-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Хост</th>
                  <th>URL</th>
                  <th>MIME</th>
                  <th>Снимок</th>
                  <th>Архив</th>
                </tr>
              </thead>
              <tbody>${recentUrlRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function formatDorkCount(value) {
    if (value === null || value === undefined || value === "") {
      return "-";
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }
    return number.toLocaleString("ru-RU");
  }

  function buildDorkStatsTable(dorkStatsData) {
    if (!dorkStatsData) {
      return '<p class="hint">Статистика дорков еще не загружена. Запустите сбор статистики, чтобы сохранить результат в проект.</p>';
    }

    const summary = dorkStatsData.summary || {};
    const rows = Array.isArray(dorkStatsData.rows) ? dorkStatsData.rows : [];
    const statCards = [
      { label: "Запросы", value: Number(summary.totalQueries) || rows.length },
      { label: "OK", value: Number(summary.ok) || 0 },
      { label: "Blocked", value: Number(summary.blocked) || 0 },
      { label: "Ошибки", value: Number(summary.errors) || 0 },
    ]
      .map(
        (item) => `
          <div class="data-stat-card">
            <div class="data-stat-value mono">${escapeHtml(String(item.value))}</div>
            <div class="data-stat-label">${escapeHtml(item.label)}</div>
          </div>
        `,
      )
      .join("");

    const tableRows = rows.length
      ? rows
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.label || item.engine || "-")}</td>
                <td class="mono">${escapeHtml(item.query || "-")}</td>
                <td class="mono">${escapeHtml(formatDorkCount(item.totalResults))}</td>
                <td class="mono">${escapeHtml(formatDorkCount(item.visibleResults))}</td>
                <td><span class="pill tiny">${escapeHtml(item.status || "-")}</span></td>
                <td>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Открыть</a>` : "-"}</td>
                <td class="webarchive-metadata-cell">${escapeHtml(item.error || "-")}</td>
              </tr>
            `,
          )
          .join("")
      : `
        <tr>
          <td colspan="7">Статистика дорков пока пустая.</td>
        </tr>
      `;

    const meta = [
      dorkStatsData.domain ? `Домен: ${dorkStatsData.domain}` : "",
      dorkStatsData.cachedAt ? `Кэшировано: ${formatDate(dorkStatsData.cachedAt)}` : "",
      dorkStatsData.loadedAt ? `Загружено: ${formatDate(dorkStatsData.loadedAt)}` : "",
    ].filter(Boolean).join(" · ");

    return `
      <div class="stack-lg">
        <div class="hint">${escapeHtml(meta || "Результаты dork stats")}</div>
        <div class="data-stat-grid">${statCards}</div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Поисковик</th>
                <th>Запрос</th>
                <th>Найдено</th>
                <th>На странице</th>
                <th>Статус</th>
                <th>Ссылка</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function buildEmailsTable(emailData, selectedEmailSourceKeys = new Set(), projectId = "") {
    if (!emailData) {
      return '<p class="hint">Почты еще не собраны.</p>';
    }

    const summary = emailData.summary || {};
    const items = Array.isArray(emailData.emails) ? emailData.emails : [];
    const statCards = [
      { label: "Всего", value: Number(summary.total) || 0 },
      { label: "IntelX", value: Number(summary.intelx) || 0 },
      { label: "WebArchive", value: Number(summary.webarchive) || 0 },
      { label: "WHOIS", value: Number(summary.whois) || 0 },
      { label: "Авторы", value: Number(summary.authors) || 0 },
      { label: "Редакторы", value: Number(summary.editors) || 0 },
    ]
      .map(
        (item) => `
          <div class="data-stat-card">
            <div class="data-stat-value mono">${escapeHtml(String(item.value))}</div>
            <div class="data-stat-label">${escapeHtml(item.label)}</div>
          </div>
        `,
      )
      .join("");

    if (!items.length) {
      return `
        <div class="stack-lg">
          <div class="data-stat-grid">${statCards}</div>
          <p class="hint">Почты из IntelX, WebArchive и WHOIS пока не найдены.</p>
        </div>
      `;
    }

    const rows = items
      .map((item) => {
        const intelxFileLinks = Array.isArray(item.intelxFiles) && item.intelxFiles.length
          ? item.intelxFiles
              .slice(0, 3)
              .map((file, index) => {
                const storageid = String(file.storageid || "").trim();
                const bucket = String(file.bucket || "leaks.public.general").trim() || "leaks.public.general";
                if (!storageid) {
                  return "";
                }
                const href = `/api/projects/${encodeURIComponent(projectId || "")}/intelx-file?storageid=${encodeURIComponent(storageid)}&bucket=${encodeURIComponent(bucket)}`;
                return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">IntelX файл ${index + 1}</a>`;
              })
              .filter(Boolean)
          : [];
        const foundDataParts = [
          Array.isArray(item.webarchiveAuthors) && item.webarchiveAuthors.length
            ? `<div>authors: ${escapeHtml(item.webarchiveAuthors.join(", "))}</div>`
            : "",
          Array.isArray(item.webarchiveEditors) && item.webarchiveEditors.length
            ? `<div>editors: ${escapeHtml(item.webarchiveEditors.join(", "))}</div>`
            : "",
          Array.isArray(item.webarchiveTitles) && item.webarchiveTitles.length
            ? `<div>titles: ${escapeHtml(item.webarchiveTitles.join(", "))}</div>`
            : "",
          Array.isArray(item.webarchiveCompanies) && item.webarchiveCompanies.length
            ? `<div>company: ${escapeHtml(item.webarchiveCompanies.join(", "))}</div>`
            : "",
          Array.isArray(item.intelxSnippets) && item.intelxSnippets.length
            ? `<div>intelx: ${escapeHtml(item.intelxSnippets.join(" | "))}</div>`
            : "",
          intelxFileLinks.length
            ? `<div>files: ${intelxFileLinks.join(" · ")}</div>`
            : "",
        ];
        const foundDataHtml = foundDataParts.filter(Boolean).join("");

        return `
          <tr>
            <td>
              <input
                type="checkbox"
                data-action="toggle-email-select"
                data-email-source-key="${escapeHtml(item.sourceKey || "")}"
                ${selectedEmailSourceKeys.has(String(item.sourceKey || "")) ? "checked" : ""}
              />
            </td>
            <td class="mono">${escapeHtml(item.email || "-")}</td>
            <td>${escapeHtml(Array.isArray(item.sources) ? item.sources.join(", ") : "-")}</td>
            <td>${escapeHtml(Array.isArray(item.intelxTerms) && item.intelxTerms.length ? item.intelxTerms.join(", ") : "-")}</td>
            <td>${escapeHtml(Array.isArray(item.webarchiveHosts) && item.webarchiveHosts.length ? item.webarchiveHosts.join(", ") : "-")}</td>
            <td class="webarchive-metadata-cell">${foundDataHtml || "-"}</td>
            <td>${item.whois ? "Да" : "-"}</td>
            <td>${item.isManual ? '<span class="pill tiny">manual</span>' : "-"}</td>
          </tr>
        `;
      })
      .join("");

    const authors = Array.isArray(emailData.authors) ? emailData.authors : [];
    const editors = Array.isArray(emailData.editors) ? emailData.editors : [];

    const authorRows = authors.length
      ? authors
          .map((item) => {
            const links = Array.isArray(item.urls) && item.urls.length
              ? item.urls
                  .slice(0, 3)
                  .map(
                    (url, index) =>
                      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Файл ${index + 1}</a>`,
                  )
                  .join(" · ")
              : "-";
            return `
              <tr>
                <td>${escapeHtml(item.name || "-")}</td>
                <td>${escapeHtml(Array.isArray(item.hosts) && item.hosts.length ? item.hosts.join(", ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.documentTypes) && item.documentTypes.length ? item.documentTypes.join(", ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.titles) && item.titles.length ? item.titles.join(" | ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.companies) && item.companies.length ? item.companies.join(", ") : "-")}</td>
                <td>${links}</td>
              </tr>
            `;
          })
          .join("")
      : `
        <tr>
          <td colspan="6">Авторы не найдены.</td>
        </tr>
      `;

    const editorRows = editors.length
      ? editors
          .map((item) => {
            const links = Array.isArray(item.urls) && item.urls.length
              ? item.urls
                  .slice(0, 3)
                  .map(
                    (url, index) =>
                      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Файл ${index + 1}</a>`,
                  )
                  .join(" · ")
              : "-";
            return `
              <tr>
                <td>${escapeHtml(item.name || "-")}</td>
                <td>${escapeHtml(Array.isArray(item.hosts) && item.hosts.length ? item.hosts.join(", ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.documentTypes) && item.documentTypes.length ? item.documentTypes.join(", ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.titles) && item.titles.length ? item.titles.join(" | ") : "-")}</td>
                <td>${escapeHtml(Array.isArray(item.companies) && item.companies.length ? item.companies.join(", ") : "-")}</td>
                <td>${links}</td>
              </tr>
            `;
          })
          .join("")
      : `
        <tr>
          <td colspan="6">Редакторы не найдены.</td>
        </tr>
      `;

    return `
      <div class="stack-lg">
        <div class="data-stat-grid">${statCards}</div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th></th>
                <th>Email</th>
                <th>Источники</th>
                <th>Термы IntelX</th>
                <th>Хосты WebArchive</th>
                <th>Найденные данные</th>
                <th>WHOIS</th>
                <th>Тип</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="stack-md">
          <div class="panel-header">
            <h3>Авторы</h3>
            <p>Из WebArchive документов</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Хосты</th>
                <th>Типы</th>
                <th>Title</th>
                <th>Company</th>
                <th>Файлы</th>
              </tr>
            </thead>
            <tbody>${authorRows}</tbody>
            </table>
          </div>
        </div>
        <div class="stack-md">
          <div class="panel-header">
            <h3>Редакторы</h3>
            <p>Из WebArchive документов</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Хосты</th>
                <th>Типы</th>
                <th>Title</th>
                <th>Company</th>
                <th>Файлы</th>
              </tr>
            </thead>
            <tbody>${editorRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  async function renderProjectPage(projectId) {
    let payload;

    try {
      payload = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    } catch (error) {
      if (error.status === 404) {
        appEl.innerHTML = `
          <section class="panel">
            ${renderErrorBanner("Проект не найден")}
            <div class="row"><a class="btn btn-primary" href="/" data-link>Назад к проектам</a></div>
          </section>
        `;
        return;
      }

      appEl.innerHTML = `
        <section class="panel">${renderErrorBanner(
          friendlyError(error, "Не удалось загрузить проект"),
        )}</section>
      `;
      return;
    }

    const project = payload.project;
    const projectDomains = formatProjectDomains(project);
    let runs = Array.isArray(project.runs) ? project.runs : [];
    let subdomains = [];
    let vtDeepData = null;
    let webarchiveData = project.webarchive || null;
    let dorkStatsData = project.dorkStats || null;
    let intelxData = null;
    let emailData = project.emails || null;
    let activeDataTab = "subdomains";
    const selectedSubdomainIds = new Set();
    const selectedEmailSourceKeys = new Set();
    const selectedIntelxHitKeys = new Set();
    let selectedRunId = runs[0] ? runs[0].id : null;
    const initialSubdomainsTotal = Number(project.counts && project.counts.subdomains) || 0;
    let subdomainsPagination = {
      page: 1,
      limit: DEFAULT_SUBDOMAINS_PAGE_SIZE,
      total: initialSubdomainsTotal,
      totalPages: Math.max(1, Math.ceil(initialSubdomainsTotal / DEFAULT_SUBDOMAINS_PAGE_SIZE)),
      hasPrev: false,
      hasNext: initialSubdomainsTotal > DEFAULT_SUBDOMAINS_PAGE_SIZE,
    };
    let subdomainsLoaded = false;
    let subdomainsRequestSeq = 0;
    let hadActiveRuns = runs.some((run) => ACTIVE_STATUSES.has(run.status));
    let runsSignature = "";
    let runsTimelineSignature = "";
    let subdomainsSignature = "";
    let runsRenderLocked = false;
    let runsRenderPending = false;
    let runsRenderUnlockTimer = null;
    let timelineClusterize = null;
    let subdomainsFilterFrame = null;
    let subdomainsFilterTimer = null;
    const completedDataRefreshKeys = new Set();
    let disposed = false;
    const projectDomainsMarkup = projectDomains
      .map((domain) => `<span class="pill mono">${escapeHtml(domain)}</span>`)
      .join("");
    const projectName = getProjectDisplayName(project);
    const primaryDomain = project.primaryDomain || project.domain || "";
    const initialIntelxCustomQuery =
      project.intelx && project.intelx.querySource === "custom" && project.intelx.customQuery
        ? String(project.intelx.customQuery)
        : "";
    const projectStatCards = [
      { label: "Поддомены", value: Number(project.counts && project.counts.subdomains) || 0 },
      { label: "DNS-записи", value: Number(project.counts && project.counts.dnsRecords) || 0 },
      { label: "Запуски", value: Number(project.counts && project.counts.runs) || 0 },
    ]
      .map(
        (item) => `
          <div class="project-hero-stat">
            <div class="project-hero-stat-value mono">${escapeHtml(String(item.value))}</div>
            <div class="project-hero-stat-label">${escapeHtml(item.label)}</div>
          </div>
        `,
      )
      .join("");

    appEl.innerHTML = `
      <div id="project-page-root">
        <div class="project-column project-column-left">
          <section class="panel hero project-hero-panel">
            <div class="project-hero-head">
              <div class="project-hero-copy">
                <div class="pill">Проект</div>
                <h1>${escapeHtml(projectName)}</h1>
                <p>Рабочая область для доменов, сканов, IntelX, WebArchive и связанных находок.</p>
              </div>
              <div class="project-hero-stats">
                ${projectStatCards}
              </div>
            </div>
            <div class="project-domain-strip">
              ${projectDomainsMarkup || '<span class="hint">Домены пока не добавлены.</span>'}
            </div>
            <form id="project-domain-form" class="project-domain-form">
              <div class="row wrap project-domain-form-row">
                <input id="project-domain-input" class="text-input mono" type="text" placeholder="Добавить домен в этот проект" />
                <button class="btn btn-secondary" id="project-domain-submit" type="submit">Добавить домен</button>
              </div>
            </form>
          </section>
        </div>

        <div class="project-column project-column-right">
          <section class="panel">
            <div class="panel-header">
              <h2>Данные</h2>
              <p id="subdomains-status-text">Автообновление каждые 3 с при активных запусках.</p>
            </div>
            <div class="row wrap project-data-tabs">
              <button class="btn btn-primary" id="tab-subdomains-btn" type="button">Поддомены</button>
              <button class="btn btn-ghost" id="tab-whois-btn" type="button">WHOIS</button>
              <button class="btn btn-ghost" id="tab-webarchive-btn" type="button">WebArchive</button>
              <button class="btn btn-ghost" id="tab-dork-stats-btn" type="button">Дорки</button>
              <button class="btn btn-ghost" id="tab-emails-btn" type="button">УЗ</button>
              <button class="btn btn-ghost" id="tab-vtdeep-btn" type="button">VT Deep</button>
              <button class="btn btn-ghost" id="tab-intelx-btn" type="button">IntelX</button>
            </div>
            <div id="subdomains-panel" class="project-data-panel">
            <div class="stack-md project-data-toolbar-stack">
              <div class="row wrap project-panel-toolbar subdomains-scan-toolbar">
                <input id="subdomains-search-input" class="text-input mono" type="search" placeholder="Поиск по поддоменам на текущей странице" />
                <button class="btn btn-primary" id="run-passive-all-btn" type="button">Запустить скан (всё)</button>
                <button class="btn btn-secondary" id="run-resolve-fast-btn" type="button">DNS-резолв (быстрый)</button>
                <button class="btn btn-ghost" id="run-resolve-extended-btn" type="button">DNS-резолв (расширенный)</button>
              </div>
              <div class="row wrap project-panel-toolbar subdomains-export-toolbar">
                <button class="btn btn-secondary" id="export-domain-ip-csv-btn" type="button">Экспорт CSV domain;ip</button>
                <button class="btn btn-ghost" id="subdomains-export-table-csv-btn" type="button">Экспорт таблицы CSV</button>
              </div>
            </div>
            <form id="subdomain-create-form">
              <div class="row wrap project-panel-toolbar">
                <input id="subdomain-create-host" class="text-input mono" type="text" placeholder="${escapeHtml(primaryDomain ? `new.${primaryDomain}` : "sub.example.com")}" />
                <button class="btn btn-primary" id="subdomain-create-btn" type="submit">Добавить поддомен</button>
                <button class="btn btn-secondary" id="resolve-selected-btn" type="button">Резолв выбранных (быстрый)</button>
                <button class="btn btn-danger" id="delete-selected-btn" type="button">Удалить выбранные</button>
                <button class="btn btn-secondary" id="export-selected-csv-btn" type="button">Экспорт выбранных</button>
                <button class="btn btn-danger" id="subdomain-delete-all-btn" type="button">Удалить все</button>
              </div>
            </form>
            <div id="subdomain-action-message"></div>
            <div id="project-action-message"></div>
            <div id="subdomains-table-root"></div>
            </div>
            <div id="whois-panel" class="project-data-panel" hidden>
              <div class="whois-block">
                <div class="panel-header">
                  <h3>WHOIS</h3>
                  <p>Снимок корневого домена</p>
                </div>
                <div class="row wrap project-panel-toolbar">
                  <button class="btn btn-secondary" id="run-whois-btn" type="button">Распознать WHOIS</button>
                  <button class="btn btn-ghost" id="whois-export-csv-btn" type="button">Экспорт CSV</button>
                </div>
                <textarea id="whois-info-field" class="text-input mono" rows="4" readonly placeholder="Здесь появится WHOIS-информация"></textarea>
              </div>
            </div>
            <div id="webarchive-panel" class="project-data-panel" hidden>
              <div class="stack-md project-data-toolbar-stack">
                <div class="row wrap project-panel-toolbar">
                  <button class="btn btn-primary" id="run-webarchive-btn" type="button">Запустить задачу WebArchive</button>
                  <button class="btn btn-secondary" id="webarchive-load-btn" type="button">Загрузить WebArchive</button>
                  <button class="btn btn-ghost" id="webarchive-refresh-metadata-btn" type="button">Переизвлечь метаданные</button>
                  <button class="btn btn-ghost" id="webarchive-export-csv-btn" type="button">Экспорт CSV</button>
                </div>
                <div class="hint">Ищет URL и документы из Wayback для доменов проекта и извлекает метаданные из PDF, DOC и DOCX.</div>
              </div>
              <div id="webarchive-action-message"></div>
              <div id="webarchive-table-root"></div>
            </div>
            <div id="emails-panel" class="project-data-panel" hidden>
              <div class="stack-md project-data-toolbar-stack">
                <div class="row wrap project-panel-toolbar">
                  <button class="btn btn-primary" id="emails-add-btn" type="button">Добавить УЗ</button>
                  <button class="btn btn-danger" id="emails-delete-selected-btn" type="button">Удалить выбранные</button>
                  <button class="btn btn-ghost" id="emails-edit-selected-btn" type="button">Изменить выбранный</button>
                  <button class="btn btn-secondary" id="emails-refresh-btn" type="button">Обновить УЗ</button>
                  <button class="btn btn-ghost" id="emails-export-csv-btn" type="button">Экспорт CSV УЗ</button>
                </div>
                <div class="hint">Агрегирует почты и связанные найденные данные из IntelX, WebArchive и WHOIS.</div>
              </div>
              <div id="emails-action-message"></div>
              <div id="emails-table-root"></div>
            </div>
            <div id="dork-stats-panel" class="project-data-panel" hidden>
              <div class="stack-md project-data-toolbar-stack">
                <div class="row wrap project-panel-toolbar">
                  <button class="btn btn-ghost" id="open-google-dork-btn" type="button" ${primaryDomain ? "" : "disabled"}>Google: site</button>
                  <button class="btn btn-ghost" id="open-google-subdomain-dork-btn" type="button" ${primaryDomain ? "" : "disabled"}>Google: *.site</button>
                  <button class="btn btn-ghost" id="open-yandex-dork-btn" type="button" ${primaryDomain ? "" : "disabled"}>Yandex: site</button>
                  <button class="btn btn-ghost" id="open-yandex-subdomain-dork-btn" type="button" ${primaryDomain ? "" : "disabled"}>Yandex: *.site</button>
                  <button class="btn btn-secondary" id="dork-stats-load-btn" type="button">Обновить статистику дорков</button>
                  <button class="btn btn-ghost" id="dork-stats-export-csv-btn" type="button">Экспорт CSV</button>
                </div>
                <div class="hint">Сохраняет примерное количество результатов Google и Yandex по site-доркам проекта.</div>
              </div>
              <div id="dork-stats-action-message"></div>
              <div id="dork-stats-table-root"></div>
            </div>
            <div id="vtdeep-panel" class="project-data-panel" hidden>
              <div class="row wrap project-panel-toolbar">
                <button class="btn btn-secondary" id="vtdeep-load-btn" type="button">Загрузить данные VT Deep</button>
                <button class="btn btn-ghost" id="vtdeep-export-csv-btn" type="button">Экспорт CSV</button>
              </div>
              <div id="vtdeep-action-message"></div>
              <div id="vtdeep-table-root"></div>
            </div>
            <div id="intelx-panel" class="project-data-panel" hidden>
              <div class="stack-md project-data-toolbar-stack">
                <div class="field">
                  <label for="intelx-custom-query">Кастомный запрос IntelX</label>
                  <textarea id="intelx-custom-query" class="text-input mono" rows="3" placeholder="Например: &quot;site:example.com&quot; или произвольный IntelX запрос">${escapeHtml(initialIntelxCustomQuery)}</textarea>
                  <div class="hint">Если поле пустое, IntelX будет искать по доменам проекта.</div>
                </div>
                <div class="row wrap project-panel-toolbar">
                  <button class="btn btn-primary" id="run-intelx-btn" type="button">Запустить задачу IntelX</button>
                  <button class="btn btn-secondary" id="intelx-load-btn" type="button">Запустить IntelX</button>
                  <button class="btn btn-ghost" id="intelx-edit-selected-btn" type="button">Изменить выбранный</button>
                  <button class="btn btn-danger" id="intelx-delete-selected-btn" type="button">Удалить выбранные</button>
                  <button class="btn btn-ghost" id="intelx-export-csv-btn" type="button">Экспорт CSV</button>
                </div>
              </div>
              <div id="intelx-action-message"></div>
              <div id="intelx-table-root"></div>
            </div>
            <div class="project-data-panel">
              <div class="row wrap project-panel-toolbar">
                <button class="btn btn-danger" id="delete-project-btn" type="button">Удалить проект</button>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2>Последние запуски</h2>
              <div class="row row-no-margin wrap">
                <p id="runs-status-text">Автообновление каждые 3 с</p>
                <button class="btn btn-ghost" id="runs-export-csv-btn" type="button">Экспорт CSV</button>
              </div>
            </div>
            <div id="runs-table-root"></div>
            <div class="run-log" id="runs-log-root"></div>
          </section>
        </div>
      </div>
    `;

    const runPassiveAllBtn = document.getElementById("run-passive-all-btn");
    const runWhoisBtn = document.getElementById("run-whois-btn");
    const runWebarchiveBtn = document.getElementById("run-webarchive-btn");
    const runIntelxBtn = document.getElementById("run-intelx-btn");
    const openGoogleDorkBtn = document.getElementById("open-google-dork-btn");
    const openGoogleSubdomainDorkBtn = document.getElementById("open-google-subdomain-dork-btn");
    const openYandexDorkBtn = document.getElementById("open-yandex-dork-btn");
    const openYandexSubdomainDorkBtn = document.getElementById("open-yandex-subdomain-dork-btn");
    const runResolveFastBtn = document.getElementById("run-resolve-fast-btn");
    const runResolveExtendedBtn = document.getElementById("run-resolve-extended-btn");
    const exportDomainIpCsvBtn = document.getElementById("export-domain-ip-csv-btn");
    const subdomainsExportTableCsvBtn = document.getElementById("subdomains-export-table-csv-btn");
    const deleteProjectBtn = document.getElementById("delete-project-btn");
    const actionMessageEl = document.getElementById("project-action-message");
    const projectDomainForm = document.getElementById("project-domain-form");
    const projectDomainInput = document.getElementById("project-domain-input");
    const projectDomainSubmit = document.getElementById("project-domain-submit");
    const whoisInfoField = document.getElementById("whois-info-field");
    const runsTableRoot = document.getElementById("runs-table-root");
    const runsLogRoot = document.getElementById("runs-log-root");
    const runsStatusText = document.getElementById("runs-status-text");
    const subdomainsTableRoot = document.getElementById("subdomains-table-root");
    const subdomainsStatusText = document.getElementById("subdomains-status-text");
    const tabSubdomainsBtn = document.getElementById("tab-subdomains-btn");
    const tabWhoisBtn = document.getElementById("tab-whois-btn");
    const tabWebarchiveBtn = document.getElementById("tab-webarchive-btn");
    const tabDorkStatsBtn = document.getElementById("tab-dork-stats-btn");
    const tabEmailsBtn = document.getElementById("tab-emails-btn");
    const tabVtDeepBtn = document.getElementById("tab-vtdeep-btn");
    const tabIntelxBtn = document.getElementById("tab-intelx-btn");
    const subdomainsPanel = document.getElementById("subdomains-panel");
    const whoisPanel = document.getElementById("whois-panel");
    const webarchivePanel = document.getElementById("webarchive-panel");
    const dorkStatsPanel = document.getElementById("dork-stats-panel");
    const emailsPanel = document.getElementById("emails-panel");
    const vtDeepPanel = document.getElementById("vtdeep-panel");
    const intelxPanel = document.getElementById("intelx-panel");
    const subdomainCreateForm = document.getElementById("subdomain-create-form");
    const subdomainCreateHostInput = document.getElementById("subdomain-create-host");
    const subdomainCreateBtn = document.getElementById("subdomain-create-btn");
    const resolveSelectedBtn = document.getElementById("resolve-selected-btn");
    const deleteSelectedBtn = document.getElementById("delete-selected-btn");
    const exportSelectedCsvBtn = document.getElementById("export-selected-csv-btn");
    const subdomainDeleteAllBtn = document.getElementById("subdomain-delete-all-btn");
    const subdomainsSearchInput = document.getElementById("subdomains-search-input");
    const subdomainActionMessageEl = document.getElementById("subdomain-action-message");
    const vtDeepLoadBtn = document.getElementById("vtdeep-load-btn");
    const vtDeepExportCsvBtn = document.getElementById("vtdeep-export-csv-btn");
    const vtDeepActionMessageEl = document.getElementById("vtdeep-action-message");
    const vtDeepTableRoot = document.getElementById("vtdeep-table-root");
    const webarchiveLoadBtn = document.getElementById("webarchive-load-btn");
    const webarchiveRefreshMetadataBtn = document.getElementById("webarchive-refresh-metadata-btn");
    const webarchiveExportCsvBtn = document.getElementById("webarchive-export-csv-btn");
    const webarchiveActionMessageEl = document.getElementById("webarchive-action-message");
    const webarchiveTableRoot = document.getElementById("webarchive-table-root");
    const dorkStatsLoadBtn = document.getElementById("dork-stats-load-btn");
    const dorkStatsExportCsvBtn = document.getElementById("dork-stats-export-csv-btn");
    const dorkStatsActionMessageEl = document.getElementById("dork-stats-action-message");
    const dorkStatsTableRoot = document.getElementById("dork-stats-table-root");
    const emailsRefreshBtn = document.getElementById("emails-refresh-btn");
    const emailsAddBtn = document.getElementById("emails-add-btn");
    const emailsDeleteSelectedBtn = document.getElementById("emails-delete-selected-btn");
    const emailsEditSelectedBtn = document.getElementById("emails-edit-selected-btn");
    const emailsExportCsvBtn = document.getElementById("emails-export-csv-btn");
    const emailsActionMessageEl = document.getElementById("emails-action-message");
    const emailsTableRoot = document.getElementById("emails-table-root");
    const intelxLoadBtn = document.getElementById("intelx-load-btn");
    const intelxCustomQueryInput = document.getElementById("intelx-custom-query");
    const intelxActionMessageEl = document.getElementById("intelx-action-message");
    const intelxTableRoot = document.getElementById("intelx-table-root");
    const intelxEditSelectedBtn = document.getElementById("intelx-edit-selected-btn");
    const intelxDeleteSelectedBtn = document.getElementById("intelx-delete-selected-btn");
    const intelxExportCsvBtn = document.getElementById("intelx-export-csv-btn");
    const whoisExportCsvBtn = document.getElementById("whois-export-csv-btn");
    const runsExportCsvBtn = document.getElementById("runs-export-csv-btn");

    function autosizeWhoisField() {
      whoisInfoField.style.height = "auto";
      whoisInfoField.style.height = `${whoisInfoField.scrollHeight}px`;
    }

    whoisInfoField.style.overflowY = "hidden";
    whoisInfoField.style.resize = "none";
    whoisInfoField.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        window.scrollBy({ top: event.deltaY, left: 0, behavior: "auto" });
      },
      { passive: false },
    );

    if (project.whois) {
      whoisInfoField.value = buildWhoisText(project.whois);
      autosizeWhoisField();
    }
    whoisExportCsvBtn.disabled = !String(whoisInfoField.value || "").trim();

    function setActionMessage(message, kind) {
      if (!message) {
        actionMessageEl.innerHTML = "";
        return;
      }

      actionMessageEl.innerHTML =
        kind === "success"
          ? renderSuccessBanner(message)
          : renderErrorBanner(message);
    }

    function setSubdomainMessage(message, kind) {
      if (!message) {
        subdomainActionMessageEl.innerHTML = "";
        return;
      }

      subdomainActionMessageEl.innerHTML =
        kind === "success"
          ? renderSuccessBanner(message)
          : renderErrorBanner(message);
    }

    function setVtDeepMessage(message, kind) {
      if (!message) {
        vtDeepActionMessageEl.innerHTML = "";
        return;
      }
      vtDeepActionMessageEl.innerHTML =
        kind === "success" ? renderSuccessBanner(message) : renderErrorBanner(message);
    }

    function setIntelxMessage(message, kind) {
      if (!message) {
        intelxActionMessageEl.innerHTML = "";
        return;
      }
      intelxActionMessageEl.innerHTML =
        kind === "success" ? renderSuccessBanner(message) : renderErrorBanner(message);
    }

    function setWebarchiveMessage(message, kind) {
      if (!message) {
        webarchiveActionMessageEl.innerHTML = "";
        return;
      }
      webarchiveActionMessageEl.innerHTML =
        kind === "success" ? renderSuccessBanner(message) : renderErrorBanner(message);
    }

    function setDorkStatsMessage(message, kind) {
      if (!message) {
        dorkStatsActionMessageEl.innerHTML = "";
        return;
      }
      dorkStatsActionMessageEl.innerHTML =
        kind === "success" ? renderSuccessBanner(message) : renderErrorBanner(message);
    }

    function setEmailsMessage(message, kind) {
      if (!message) {
        emailsActionMessageEl.innerHTML = "";
        return;
      }
      emailsActionMessageEl.innerHTML =
        kind === "success" ? renderSuccessBanner(message) : renderErrorBanner(message);
    }

    function renderDataTab() {
      const showSubdomains = activeDataTab === "subdomains";
      const showWhois = activeDataTab === "whois";
      const showWebarchive = activeDataTab === "webarchive";
      const showDorkStats = activeDataTab === "dorkStats";
      const showEmails = activeDataTab === "emails";
      const showVtDeep = activeDataTab === "vtdeep";
      const showIntelx = activeDataTab === "intelx";
      subdomainsPanel.hidden = !showSubdomains;
      whoisPanel.hidden = !showWhois;
      webarchivePanel.hidden = !showWebarchive;
      dorkStatsPanel.hidden = !showDorkStats;
      emailsPanel.hidden = !showEmails;
      vtDeepPanel.hidden = !showVtDeep;
      intelxPanel.hidden = !showIntelx;
      tabSubdomainsBtn.className = showSubdomains ? "btn btn-primary" : "btn btn-ghost";
      tabWhoisBtn.className = showWhois ? "btn btn-primary" : "btn btn-ghost";
      tabWebarchiveBtn.className = showWebarchive ? "btn btn-primary" : "btn btn-ghost";
      tabDorkStatsBtn.className = showDorkStats ? "btn btn-primary" : "btn btn-ghost";
      tabEmailsBtn.className = showEmails ? "btn btn-primary" : "btn btn-ghost";
      tabVtDeepBtn.className = showVtDeep ? "btn btn-primary" : "btn btn-ghost";
      tabIntelxBtn.className = showIntelx ? "btn btn-primary" : "btn btn-ghost";
    }

    function createRunsSignature(list) {
      return list
        .map((run) => `${run.id}|${run.status}|${run.progress}|${run.stage}|${run.cancelRequested ? 1 : 0}|${run.finishedAt || run.startedAt || run.createdAt || ""}`)
        .join(";");
    }

    function createRunTimelineSignature(list, activeSelectedRunId) {
      const selectedRun =
        list.find((run) => run.id === activeSelectedRunId) ||
        list.find((run) => ACTIVE_STATUSES.has(run.status)) ||
        list[0];

      if (!selectedRun) {
        return "empty";
      }

      const events = Array.isArray(selectedRun.events) ? selectedRun.events : [];
      const eventsSig = events
        .map((event) => `${event.id}|${event.progress}|${event.stage}|${event.createdAt || ""}`)
        .join(",");
      return `${selectedRun.id}|${selectedRun.status}|${eventsSig}`;
    }

    function createSubdomainsSignature(list, pagination) {
      const page = Math.max(1, Number(pagination && pagination.page) || 1);
      const limit = normalizeSubdomainsPageSize(pagination && pagination.limit);
      const total = Math.max(0, Number(pagination && pagination.total) || 0);
      const totalPages = Math.max(1, Number(pagination && pagination.totalPages) || 1);
      const rowsSignature = list
        .map((item) => `${item.id}|${item.host}|${item.updatedAt || ""}|${Array.isArray(item.sources) ? item.sources.length : 0}|${Array.isArray(item.dnsRecords) ? item.dnsRecords.length : 0}`)
        .join(";");
      return `${page}|${limit}|${total}|${totalPages}|${rowsSignature}`;
    }

    function applySubdomainsSearchFilter() {
      if (!subdomainsSearchInput) {
        return;
      }

      const query = String(subdomainsSearchInput.value || "").trim().toLowerCase();
      const rows = subdomainsTableRoot.querySelectorAll("tbody tr");

      rows.forEach((row) => {
        const firstCell = row.querySelector("td");
        const hostText = String(firstCell ? firstCell.textContent || "" : "").toLowerCase();
        const matches = !query || hostText.includes(query);
        row.hidden = !matches;
      });

    }

    function scheduleSubdomainsSearchFilter() {
      if (subdomainsFilterTimer) {
        clearTimeout(subdomainsFilterTimer);
      }
      subdomainsFilterTimer = setTimeout(() => {
        subdomainsFilterTimer = null;
        if (subdomainsFilterFrame) {
          cancelAnimationFrame(subdomainsFilterFrame);
        }
        subdomainsFilterFrame = requestAnimationFrame(() => {
          subdomainsFilterFrame = null;
          applySubdomainsSearchFilter();
        });
      }, DEBOUNCE_FAST_MS);
    }

    function renderRunsTable() {
      runsTableRoot.innerHTML = buildRunsTable(runs, selectedRunId);

      const hasActive = runs.some((run) => ACTIVE_STATUSES.has(run.status));
      runsStatusText.textContent = hasActive ? "Автообновление каждые 3 с" : "Ожидание";
      runsExportCsvBtn.disabled = runs.length === 0;
    }

    function renderRunsTimeline(force = false) {
      const nextSignature = createRunTimelineSignature(runs, selectedRunId);
      if (!force && nextSignature === runsTimelineSignature) {
        return;
      }
      runsTimelineSignature = nextSignature;
      const pageScrollY = window.scrollY;
      const prevTimelineScroll = (() => {
        const currentScrollEl = runsLogRoot.querySelector(".clusterize-scroll, .timeline-scroll");
        return currentScrollEl ? currentScrollEl.scrollTop : 0;
      })();

      function restoreScroll(nextTimelineEl) {
        if (nextTimelineEl) {
          nextTimelineEl.scrollTop = prevTimelineScroll;
        }
        window.scrollTo(0, pageScrollY);
      }

      const selectedRun = pickTimelineRun(runs, selectedRunId);
      if (!selectedRun) {
        if (timelineClusterize && typeof timelineClusterize.destroy === "function") {
          timelineClusterize.destroy(true);
        }
        timelineClusterize = null;
        runsLogRoot.innerHTML = '<p class="hint">Нет данных таймлайна.</p>';
        restoreScroll(null);
        return;
      }

      if (typeof window.Clusterize !== "function") {
        runsLogRoot.innerHTML = buildRunTimelineFallback(runs, selectedRunId);
        restoreScroll(runsLogRoot.querySelector(".timeline-scroll"));
        return;
      }

      runsLogRoot.innerHTML = `
        <div class="panel-header">
          <h3>Таймлайн запуска</h3>
          <p>${escapeHtml(formatRunTypeLabel(selectedRun))} · ${escapeHtml(selectedRun.status)}</p>
        </div>
        <div class="timeline-scroll clusterize-scroll">
          <ol class="timeline clusterize-content"></ol>
        </div>
      `;

      const rows = buildRunTimelineRows(selectedRun);
      const scrollElem = runsLogRoot.querySelector(".clusterize-scroll");
      const contentElem = runsLogRoot.querySelector(".clusterize-content");

      if (!scrollElem || !contentElem) {
        runsLogRoot.innerHTML = buildRunTimelineFallback(runs, selectedRunId);
        restoreScroll(runsLogRoot.querySelector(".timeline-scroll"));
        return;
      }

      if (timelineClusterize && typeof timelineClusterize.destroy === "function") {
        timelineClusterize.destroy(true);
      }

      timelineClusterize = new window.Clusterize({
        rows,
        scrollElem,
        contentElem,
        no_data_text: "Событий пока нет.",
      });
      restoreScroll(scrollElem);
    }

    function renderRuns(forceTimeline = false) {
      renderRunsTable();
      renderRunsTimeline(forceTimeline);
    }

    function scheduleRunsRenderUnlock() {
      if (runsRenderUnlockTimer) {
        clearTimeout(runsRenderUnlockTimer);
      }
      runsRenderUnlockTimer = setTimeout(() => {
        runsRenderLocked = false;
        if (runsRenderPending) {
          runsRenderPending = false;
          renderRuns(false);
        }
      }, 700);
    }

    function lockRunsRenderDuringInteraction() {
      runsRenderLocked = true;
      scheduleRunsRenderUnlock();
    }

    function renderSubdomains() {
      const hasActive = runs.some((run) => ACTIVE_STATUSES.has(run.status));
      subdomainsStatusText.textContent = hasActive
        ? "Автообновление каждые 3 с при активных запусках."
        : "Ожидание";
      resolveSelectedBtn.disabled = selectedSubdomainIds.size === 0;
      deleteSelectedBtn.disabled = selectedSubdomainIds.size === 0;
      exportSelectedCsvBtn.disabled = selectedSubdomainIds.size === 0;
      subdomainsExportTableCsvBtn.disabled = !subdomainsLoaded || subdomains.length === 0;
      resolveSelectedBtn.textContent = selectedSubdomainIds.size > 0
        ? `Резолв выбранных (быстрый) [${selectedSubdomainIds.size}]`
        : "Резолв выбранных (быстрый)";
      deleteSelectedBtn.textContent = selectedSubdomainIds.size > 0
        ? `Удалить выбранные [${selectedSubdomainIds.size}]`
        : "Удалить выбранные";
      exportSelectedCsvBtn.textContent = selectedSubdomainIds.size > 0
        ? `Экспорт выбранных [${selectedSubdomainIds.size}]`
        : "Экспорт выбранных";

      if (!subdomainsLoaded) {
        subdomainsTableRoot.innerHTML = '<p class="hint">Загрузка поддоменов...</p>';
        return;
      }

      subdomainsTableRoot.innerHTML = buildSubdomainsTable(
        subdomains,
        subdomainsPagination,
        selectedSubdomainIds,
      );

      applySubdomainsSearchFilter();
    }

    function renderVtDeep() {
      vtDeepExportCsvBtn.disabled = !vtDeepData;
      vtDeepTableRoot.innerHTML = buildVtDeepTable(vtDeepData);
      if (vtDeepData && Array.isArray(vtDeepData.warnings) && vtDeepData.warnings.length) {
        setVtDeepMessage(`Предупреждения: ${vtDeepData.warnings.join("; ")}`, "error");
      } else {
        setVtDeepMessage("", "");
      }
    }

    function renderIntelx() {
      const searches = Array.isArray(intelxData?.searches) ? intelxData.searches : [];
      const validHitKeys = new Set();
      searches.forEach((entry, searchIndex) => {
        const hits = Array.isArray(entry?.hits) ? entry.hits : [];
        hits.forEach((_hit, hitIndex) => {
          validHitKeys.add(`${searchIndex}:${hitIndex}`);
        });
      });
      for (const key of Array.from(selectedIntelxHitKeys)) {
        if (!validHitKeys.has(key)) {
          selectedIntelxHitKeys.delete(key);
        }
      }

      intelxEditSelectedBtn.disabled = selectedIntelxHitKeys.size !== 1;
      intelxDeleteSelectedBtn.disabled = selectedIntelxHitKeys.size === 0;
      intelxExportCsvBtn.disabled = !intelxData;
      intelxDeleteSelectedBtn.textContent = selectedIntelxHitKeys.size > 0
        ? `Удалить выбранные [${selectedIntelxHitKeys.size}]`
        : "Удалить выбранные";
      intelxTableRoot.innerHTML = buildIntelxTable(intelxData, projectId, selectedIntelxHitKeys);
      if (intelxData && Array.isArray(intelxData.warnings) && intelxData.warnings.length) {
        setIntelxMessage(`Предупреждения: ${intelxData.warnings.join("; ")}`, "error");
      } else {
        setIntelxMessage("", "");
      }
    }

    function parseIntelxHitKey(key) {
      const [searchIndexRaw, hitIndexRaw] = String(key || "").split(":");
      const searchIndex = Number.parseInt(searchIndexRaw, 10);
      const hitIndex = Number.parseInt(hitIndexRaw, 10);
      if (!Number.isInteger(searchIndex) || searchIndex < 0 || !Number.isInteger(hitIndex) || hitIndex < 0) {
        return null;
      }
      return { searchIndex, hitIndex };
    }

    function getIntelxHitByKey(key) {
      const ref = parseIntelxHitKey(key);
      if (!ref) {
        return null;
      }
      const search = Array.isArray(intelxData?.searches) ? intelxData.searches[ref.searchIndex] : null;
      const hit = search && Array.isArray(search.hits) ? search.hits[ref.hitIndex] : null;
      return hit ? { ref, search, hit } : null;
    }

    function renderWebArchive() {
      webarchiveExportCsvBtn.disabled = !webarchiveData;
      webarchiveTableRoot.innerHTML = buildWebArchiveTable(webarchiveData);
      setWebarchiveMessage("", "");
    }

    function renderDorkStats() {
      dorkStatsExportCsvBtn.disabled = !dorkStatsData;
      dorkStatsTableRoot.innerHTML = buildDorkStatsTable(dorkStatsData);
      setDorkStatsMessage("", "");
    }

    function renderEmails() {
      const rows = Array.isArray(emailData?.emails) ? emailData.emails : [];
      for (const key of Array.from(selectedEmailSourceKeys)) {
        if (!rows.some((item) => String(item.sourceKey || "") === key)) {
          selectedEmailSourceKeys.delete(key);
        }
      }
      emailsDeleteSelectedBtn.disabled = selectedEmailSourceKeys.size === 0;
      emailsEditSelectedBtn.disabled = selectedEmailSourceKeys.size !== 1;
      emailsDeleteSelectedBtn.textContent = selectedEmailSourceKeys.size > 0
        ? `Удалить выбранные [${selectedEmailSourceKeys.size}]`
        : "Удалить выбранные";
      emailsTableRoot.innerHTML = buildEmailsTable(emailData, selectedEmailSourceKeys, projectId);
      setEmailsMessage("", "");
    }

    function renderActiveDataTabContent() {
      if (activeDataTab === "subdomains") {
        renderSubdomains();
      } else if (activeDataTab === "whois") {
        autosizeWhoisField();
      } else if (activeDataTab === "webarchive") {
        renderWebArchive();
      } else if (activeDataTab === "dorkStats") {
        renderDorkStats();
      } else if (activeDataTab === "emails") {
        renderEmails();
      } else if (activeDataTab === "vtdeep") {
        renderVtDeep();
      } else if (activeDataTab === "intelx") {
        renderIntelx();
      }
    }

    async function refreshSubdomains(forceRender = false, options = {}) {
      const requestedPage = Math.max(1, Number(options.page) || Number(subdomainsPagination.page) || 1);
      const requestedLimit = normalizeSubdomainsPageSize(
        Object.prototype.hasOwnProperty.call(options, "limit")
          ? options.limit
          : subdomainsPagination.limit,
      );
      const query = new URLSearchParams({
        page: String(requestedPage),
        limit: String(requestedLimit),
      });
      const requestSeq = (subdomainsRequestSeq += 1);
      const payloadSubdomains = await api(
        `/api/projects/${encodeURIComponent(projectId)}/subdomains?${query.toString()}`,
      );
      if (disposed) {
        return;
      }
      if (requestSeq !== subdomainsRequestSeq) {
        return;
      }
      const nextSubdomains = Array.isArray(payloadSubdomains.subdomains) ? payloadSubdomains.subdomains : [];
      const rawPagination = payloadSubdomains && payloadSubdomains.pagination
        ? payloadSubdomains.pagination
        : {};
      const nextLimit = normalizeSubdomainsPageSize(rawPagination.limit || requestedLimit);
      const nextTotal = Math.max(0, Number(rawPagination.total) || 0);
      const nextTotalPages = Math.max(
        1,
        Number(rawPagination.totalPages) || Math.ceil(nextTotal / Math.max(nextLimit, 1)) || 1,
      );
      const nextPage = Math.max(1, Math.min(nextTotalPages, Number(rawPagination.page) || requestedPage));
      const nextPagination = {
        page: nextPage,
        limit: nextLimit,
        total: nextTotal,
        totalPages: nextTotalPages,
        hasPrev: typeof rawPagination.hasPrev === "boolean" ? rawPagination.hasPrev : nextPage > 1,
        hasNext: typeof rawPagination.hasNext === "boolean" ? rawPagination.hasNext : nextPage < nextTotalPages,
      };
      const nextSubdomainsSignature = createSubdomainsSignature(nextSubdomains, nextPagination);
      if (!forceRender && nextSubdomainsSignature === subdomainsSignature) {
        return;
      }

      subdomains = nextSubdomains;
      subdomainsPagination = nextPagination;
      subdomainsLoaded = true;
      subdomainsSignature = nextSubdomainsSignature;
      renderSubdomains();
    }

    async function refreshWhoisInfo() {
      try {
        const payloadWhois = await api(`/api/projects/${encodeURIComponent(projectId)}/whois`);
        if (disposed) {
          return;
        }
        whoisInfoField.value = buildWhoisText(payloadWhois && payloadWhois.whois);
        autosizeWhoisField();
        whoisExportCsvBtn.disabled = !String(whoisInfoField.value || "").trim();
      } catch {
        // ignore background whois refresh errors
      }
    }

    async function refreshVtDeepInfo() {
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/vt-deep`);
        if (disposed) {
          return;
        }
        vtDeepData = payload && payload.result ? payload.result : null;
        if (activeDataTab === "vtdeep") {
          renderVtDeep();
        }
      } catch {
        // ignore background vt deep refresh errors
      }
    }

    async function refreshWebArchiveInfo() {
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/webarchive`);
        if (disposed) {
          return;
        }
        webarchiveData = payload && payload.result ? payload.result : null;
        if (activeDataTab === "webarchive") {
          renderWebArchive();
        }
      } catch (error) {
        setWebarchiveMessage(friendlyError(error, "Не удалось загрузить данные WebArchive"), "error");
      }
    }

    async function refreshDorkStatsInfo() {
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/dork-stats`);
        if (disposed) {
          return;
        }
        dorkStatsData = payload && payload.result ? payload.result : null;
        if (activeDataTab === "dorkStats") {
          renderDorkStats();
        }
      } catch (error) {
        setDorkStatsMessage(friendlyError(error, "Не удалось загрузить статистику дорков"), "error");
      }
    }

    async function refreshEmailsInfo() {
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/emails`);
        if (disposed) {
          return;
        }
        emailData = payload && payload.result ? payload.result : null;
        if (activeDataTab === "emails") {
          renderEmails();
        }
      } catch (error) {
        setEmailsMessage(friendlyError(error, "Не удалось загрузить УЗ"), "error");
      }
    }

    async function refreshIntelxInfo() {
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/intelx-leaks`);
        if (disposed) {
          return;
        }
        intelxData = payload && payload.result ? payload.result : null;
        if (activeDataTab === "intelx") {
          renderIntelx();
        }
      } catch (error) {
        setIntelxMessage(friendlyError(error, "Не удалось загрузить данные IntelX"), "error");
      }
    }

    async function refreshRuns() {
      if (disposed) {
        return;
      }

      try {
        const payloadRuns = await api(`/api/projects/${encodeURIComponent(projectId)}/runs`);
        if (disposed) {
          return;
        }

        const prevTopRunId = runs[0] ? runs[0].id : null;
        const nextRuns = Array.isArray(payloadRuns.runs) ? payloadRuns.runs : [];
        const nextRunsSignature = createRunsSignature(nextRuns);
        runs = nextRuns;
        const nextTopRun = runs[0] || null;
        const shouldAutoFocusNewest =
          Boolean(nextTopRun) &&
          nextTopRun.id !== prevTopRunId &&
          ACTIVE_STATUSES.has(nextTopRun.status);
        if (shouldAutoFocusNewest) {
          selectedRunId = nextTopRun.id;
          runsTimelineSignature = "";
        }

        if (!runs.some((run) => run.id === selectedRunId)) {
          selectedRunId = runs[0] ? runs[0].id : null;
        }

        if (nextRunsSignature !== runsSignature) {
          runsSignature = nextRunsSignature;
          if (runsRenderLocked) {
            runsRenderPending = true;
          } else {
            renderRuns(shouldAutoFocusNewest);
          }
        } else if (!runsRenderLocked) {
          // Even when table signature is unchanged, timeline events may update.
          renderRunsTimeline(false);
        }

        function hasNewSuccessfulRun(taskKind) {
          return runs.some((run) => {
            if (run.taskKind !== taskKind || run.status !== "SUCCESS") {
              return false;
            }
            const key = `${taskKind}:${run.id || run.finishedAt || run.startedAt || ""}`;
            if (completedDataRefreshKeys.has(key)) {
              return false;
            }
            completedDataRefreshKeys.add(key);
            return true;
          });
        }

        if (hasNewSuccessfulRun("WHOIS")) {
          await refreshWhoisInfo();
        }
        if (hasNewSuccessfulRun("VT_DEEP")) {
          await refreshVtDeepInfo();
        }
        if (hasNewSuccessfulRun("WEBARCHIVE")) {
          await refreshWebArchiveInfo();
          await refreshEmailsInfo();
        }
        if (hasNewSuccessfulRun("WEBARCHIVE_METADATA")) {
          await refreshWebArchiveInfo();
          await refreshEmailsInfo();
        }
        if (hasNewSuccessfulRun("DORK_STATS")) {
          await refreshDorkStatsInfo();
        }
        if (hasNewSuccessfulRun("INTELX_LEAKS")) {
          await refreshIntelxInfo();
          await refreshEmailsInfo();
        }
        const hasActiveRuns = runs.some((run) => ACTIVE_STATUSES.has(run.status));
        const shouldRefreshSubdomains = hasActiveRuns || hadActiveRuns;
        hadActiveRuns = hasActiveRuns;
        if (shouldRefreshSubdomains) {
          await refreshSubdomains();
        }
      } catch {
        // silent polling failure
      }
    }

    function setActionButtonsDisabled(disabled) {
      runPassiveAllBtn.disabled = disabled;
      runWhoisBtn.disabled = disabled;
      runWebarchiveBtn.disabled = disabled;
      runIntelxBtn.disabled = disabled;
      openGoogleDorkBtn.disabled = disabled || !primaryDomain;
      openGoogleSubdomainDorkBtn.disabled = disabled || !primaryDomain;
      openYandexDorkBtn.disabled = disabled || !primaryDomain;
      openYandexSubdomainDorkBtn.disabled = disabled || !primaryDomain;
      dorkStatsLoadBtn.disabled = disabled || !primaryDomain;
      runResolveFastBtn.disabled = disabled;
      runResolveExtendedBtn.disabled = disabled;
      exportDomainIpCsvBtn.disabled = disabled;
      subdomainsExportTableCsvBtn.disabled = disabled || !subdomainsLoaded || subdomains.length === 0;
      deleteProjectBtn.disabled = disabled;
      projectDomainInput.disabled = disabled;
      projectDomainSubmit.disabled = disabled;
      vtDeepLoadBtn.disabled = disabled;
      vtDeepExportCsvBtn.disabled = disabled || !vtDeepData;
      webarchiveLoadBtn.disabled = disabled;
      webarchiveRefreshMetadataBtn.disabled = disabled;
      webarchiveExportCsvBtn.disabled = disabled || !webarchiveData;
      emailsRefreshBtn.disabled = disabled;
      emailsAddBtn.disabled = disabled;
      emailsDeleteSelectedBtn.disabled = disabled || selectedEmailSourceKeys.size === 0;
      emailsEditSelectedBtn.disabled = disabled || selectedEmailSourceKeys.size !== 1;
      emailsExportCsvBtn.disabled = disabled;
      intelxLoadBtn.disabled = disabled;
      intelxEditSelectedBtn.disabled = disabled || selectedIntelxHitKeys.size !== 1;
      intelxDeleteSelectedBtn.disabled = disabled || selectedIntelxHitKeys.size === 0;
      intelxExportCsvBtn.disabled = disabled || !intelxData;
      dorkStatsExportCsvBtn.disabled = disabled || !dorkStatsData;
      whoisExportCsvBtn.disabled = disabled || !String(whoisInfoField.value || "").trim();
      runsExportCsvBtn.disabled = disabled || runs.length === 0;
      resolveSelectedBtn.disabled = disabled || selectedSubdomainIds.size === 0;
      deleteSelectedBtn.disabled = disabled || selectedSubdomainIds.size === 0;
      exportSelectedCsvBtn.disabled = disabled || selectedSubdomainIds.size === 0;
      if (subdomainsSearchInput) {
        subdomainsSearchInput.disabled = disabled;
      }
    }

    async function queueAction(endpoint, successMessage, body) {
      setActionButtonsDisabled(true);
      setActionMessage("", "");

      try {
        await api(endpoint, { method: "POST", body });
        showPopup(successMessage, "success");
        await refreshRuns();
      } catch (error) {
        setActionMessage(friendlyError(error, "Не удалось выполнить действие"), "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    }

    function buildIntelxTaskBody() {
      const customQuery = intelxCustomQueryInput ? intelxCustomQueryInput.value.trim() : "";
      return customQuery ? { customQuery } : {};
    }

    function projectCsvFileName(suffix) {
      return `${getProjectFileStem(project)}-${suffix}.csv`;
    }

    function exportRowsCsv(filename, headers, rows, emptyMessage, setMessage) {
      if (!rows.length) {
        setMessage(emptyMessage, "error");
        return;
      }
      downloadCsvFile(filename, headers, rows);
      setMessage("CSV экспортирован", "success");
    }

    function exportRunsCsv() {
      const headers = ["type", "taskKind", "scanScope", "status", "progress", "processed", "total", "stage", "startedAt", "finishedAt", "error"];
      const rows = runs.map((run) => ({
        type: run.type || "",
        taskKind: run.taskKind || "",
        scanScope: run.scanScope || "",
        status: run.status || "",
        progress: Number(run.progress) || 0,
        processed: Number(run.processed) || 0,
        total: run.total ?? "",
        stage: run.stage || "",
        startedAt: run.startedAt || "",
        finishedAt: run.finishedAt || "",
        error: run.error || "",
      }));
      exportRowsCsv(projectCsvFileName("runs"), headers, rows, "Запусков для экспорта нет", setActionMessage);
    }

    function exportSubdomainsTableCsv() {
      const headers = ["host", "isRoot", "sources", "ips", "updatedAt"];
      const rows = subdomains.map((subdomain) => {
        const ips = Array.from(
          new Set(
            (subdomain.dnsRecords || [])
              .filter((record) => record.recordType === "A" || record.recordType === "AAAA")
              .map((record) => record.value),
          ),
        );
        return {
          host: subdomain.host || "",
          isRoot: subdomain.isRoot ? "1" : "0",
          sources: Array.isArray(subdomain.sources) ? subdomain.sources.map((item) => item.source).join(", ") : "",
          ips: ips.join(", "),
          updatedAt: subdomain.updatedAt || "",
        };
      });
      exportRowsCsv(projectCsvFileName("subdomains-page"), headers, rows, "Поддоменов для экспорта нет", setSubdomainMessage);
    }

    function exportWhoisCsv() {
      const headers = ["field", "value"];
      const rows = String(whoisInfoField.value || "")
        .split(/\r?\n/)
        .map((line) => {
          const idx = line.indexOf(":");
          return idx >= 0
            ? { field: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() }
            : { field: "", value: line.trim() };
        })
        .filter((row) => row.field || row.value);
      exportRowsCsv(projectCsvFileName("whois"), headers, rows, "WHOIS для экспорта пуст", setActionMessage);
    }

    function exportVtDeepCsv() {
      const headers = ["relationship", "name", "sha256", "id", "positives", "total", "lastSeen", "vtLink"];
      const rows = (Array.isArray(vtDeepData?.files) ? vtDeepData.files : []).map((item) => ({
        relationship: item.relationship || "",
        name: item.name || "",
        sha256: item.sha256 || "",
        id: item.id || "",
        positives: item.positives ?? "",
        total: item.total ?? "",
        lastSeen: item.lastSeen || "",
        vtLink: item.vtLink || "",
      }));
      exportRowsCsv(projectCsvFileName("vtdeep"), headers, rows, "VT Deep данных для экспорта нет", setVtDeepMessage);
    }

    function exportDorkStatsCsv() {
      const headers = ["label", "engine", "query", "totalResults", "visibleResults", "status", "url", "error"];
      const rows = (Array.isArray(dorkStatsData?.rows) ? dorkStatsData.rows : []).map((item) => ({
        label: item.label || "",
        engine: item.engine || "",
        query: item.query || "",
        totalResults: item.totalResults ?? "",
        visibleResults: item.visibleResults ?? "",
        status: item.status || "",
        url: item.url || "",
        error: item.error || "",
      }));
      exportRowsCsv(projectCsvFileName("dork-stats"), headers, rows, "Статистики дорков для экспорта нет", setDorkStatsMessage);
    }

    function exportIntelxCsv() {
      const headers = ["term", "count", "fileName", "storageid", "bucket", "line"];
      const rows = [];
      const searches = Array.isArray(intelxData?.searches) ? intelxData.searches : [];
      searches.forEach((entry) => {
        const hits = Array.isArray(entry?.hits) ? entry.hits : [];
        hits.forEach((hit) => {
          rows.push({
            term: entry.term || "",
            count: entry.count ?? hits.length,
            fileName: formatIntelxFileName(hit),
            storageid: hit.storageid || "",
            bucket: hit.bucket || "leaks.public.general",
            line: hit.line || "",
          });
        });
      });
      exportRowsCsv(projectCsvFileName("intelx"), headers, rows, "IntelX данных для экспорта нет", setIntelxMessage);
    }

    function exportWebArchiveCsv() {
      const headers = [
        "kind",
        "type",
        "host",
        "url",
        "mimetype",
        "capturedAt",
        "author",
        "lastModifiedBy",
        "title",
        "company",
        "emails",
        "length",
        "metadataStatus",
        "archiveUrl",
      ];
      const rows = [];
      const documents = Array.isArray(webarchiveData?.documents) ? webarchiveData.documents : [];
      documents.forEach((item) => {
        rows.push({
          kind: "document",
          type: String(item.type || "").toUpperCase(),
          host: item.host || "",
          url: item.url || "",
          mimetype: item.mimetype || "",
          capturedAt: item.capturedAt || "",
          author: item.metadata?.author || "",
          lastModifiedBy: item.metadata?.lastModifiedBy || "",
          title: item.metadata?.title || "",
          company: item.metadata?.company || item.metadata?.application || item.metadata?.producer || "",
          emails: csvList(item.metadata?.emails),
          length: item.length ?? "",
          metadataStatus: item.metadataStatus || "",
          archiveUrl: item.archiveUrl || "",
        });
      });
      const recentUrls = Array.isArray(webarchiveData?.recentUrls) ? webarchiveData.recentUrls : [];
      recentUrls.forEach((item) => {
        rows.push({
          kind: "recent_url",
          type: "",
          host: item.host || "",
          url: item.url || "",
          mimetype: item.mimetype || "",
          capturedAt: item.capturedAt || "",
          author: "",
          lastModifiedBy: "",
          title: "",
          company: "",
          emails: "",
          length: "",
          metadataStatus: "",
          archiveUrl: item.archiveUrl || "",
        });
      });
      exportRowsCsv(projectCsvFileName("webarchive"), headers, rows, "WebArchive данных для экспорта нет", setWebarchiveMessage);
    }

    runsTableRoot.addEventListener("click", async (event) => {
      const selectButton = closestAction(event.target, "select-run");
      if (selectButton && runsTableRoot.contains(selectButton)) {
        selectedRunId = selectButton.getAttribute("data-run-id");
        renderRunsTable();
        renderRunsTimeline(true);
        return;
      }

      const cancelButton = closestAction(event.target, "cancel-run");
      if (!cancelButton || !runsTableRoot.contains(cancelButton)) {
        return;
      }

      const runId = cancelButton.getAttribute("data-run-id");
      if (!runId) {
        return;
      }

      cancelButton.disabled = true;
      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
          body: {},
        });
        setActionMessage("Запрошена отмена", "success");
        await refreshRuns();
      } catch (error) {
        setActionMessage(friendlyError(error, "Не удалось отменить запуск"), "error");
      } finally {
        cancelButton.disabled = false;
      }
    });

    subdomainsTableRoot.addEventListener("click", async (event) => {
      const prevPageBtn = closestAction(event.target, "subdomains-prev-page");
      if (prevPageBtn && subdomainsTableRoot.contains(prevPageBtn)) {
        const targetPage = Math.max(1, (Number(subdomainsPagination.page) || 1) - 1);
        void refreshSubdomains(true, { page: targetPage });
        return;
      }

      const nextPageBtn = closestAction(event.target, "subdomains-next-page");
      if (nextPageBtn && subdomainsTableRoot.contains(nextPageBtn)) {
        const totalPages = Math.max(1, Number(subdomainsPagination.totalPages) || 1);
        const targetPage = Math.min(totalPages, (Number(subdomainsPagination.page) || 1) + 1);
        void refreshSubdomains(true, { page: targetPage });
        return;
      }

      const editButton = closestAction(event.target, "edit-subdomain");
      if (editButton && subdomainsTableRoot.contains(editButton)) {
        const subdomainId = editButton.getAttribute("data-subdomain-id");
        const currentHost = editButton.getAttribute("data-host") || "";
        if (!subdomainId) {
          return;
        }

        const nextHost = window.prompt("Изменить хост поддомена", currentHost);
        if (nextHost === null) {
          return;
        }

        editButton.disabled = true;
        setSubdomainMessage("", "");
        try {
          await api(
            `/api/projects/${encodeURIComponent(projectId)}/subdomains/${encodeURIComponent(subdomainId)}`,
            { method: "PUT", body: { host: nextHost } },
          );
          setSubdomainMessage("Поддомен обновлен", "success");
          await refreshSubdomains(true);
        } catch (error) {
          setSubdomainMessage(friendlyError(error, "Не удалось обновить поддомен"), "error");
        } finally {
          editButton.disabled = false;
        }
        return;
      }

      const deleteButton = closestAction(event.target, "delete-subdomain");
      if (!deleteButton || !subdomainsTableRoot.contains(deleteButton)) {
        return;
      }

      const subdomainId = deleteButton.getAttribute("data-subdomain-id");
      if (!subdomainId || !window.confirm("Удалить этот поддомен?")) {
        return;
      }

      deleteButton.disabled = true;
      setSubdomainMessage("", "");
      try {
        await api(
          `/api/projects/${encodeURIComponent(projectId)}/subdomains/${encodeURIComponent(subdomainId)}`,
          { method: "DELETE" },
        );
        setSubdomainMessage("Поддомен удален", "success");
        await refreshSubdomains(true);
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось удалить поддомен"), "error");
      } finally {
        deleteButton.disabled = false;
      }
    });

    subdomainsTableRoot.addEventListener("change", (event) => {
      const pageSizeSelect = closestAction(event.target, "subdomains-page-size");
      if (pageSizeSelect && subdomainsTableRoot.contains(pageSizeSelect)) {
        const nextLimit = normalizeSubdomainsPageSize(pageSizeSelect.value);
        if (nextLimit !== normalizeSubdomainsPageSize(subdomainsPagination.limit)) {
          void refreshSubdomains(true, { page: 1, limit: nextLimit });
        }
        return;
      }

      const selectAllToggle = closestAction(event.target, "subdomains-select-all");
      if (selectAllToggle && subdomainsTableRoot.contains(selectAllToggle)) {
        const rowToggles = subdomainsTableRoot.querySelectorAll("[data-action='toggle-subdomain-select']");
        rowToggles.forEach((checkbox) => {
          const id = checkbox.getAttribute("data-subdomain-id");
          if (!id) {
            return;
          }
          if (selectAllToggle.checked) {
            selectedSubdomainIds.add(String(id));
          } else {
            selectedSubdomainIds.delete(String(id));
          }
        });
        renderSubdomains();
        return;
      }

      const rowToggle = closestAction(event.target, "toggle-subdomain-select");
      if (!rowToggle || !subdomainsTableRoot.contains(rowToggle)) {
        return;
      }

      const id = rowToggle.getAttribute("data-subdomain-id");
      if (!id) {
        return;
      }
      if (rowToggle.checked) {
        selectedSubdomainIds.add(String(id));
      } else {
        selectedSubdomainIds.delete(String(id));
      }
      renderSubdomains();
    });

    emailsTableRoot.addEventListener("change", (event) => {
      const checkbox = closestAction(event.target, "toggle-email-select");
      if (!checkbox || !emailsTableRoot.contains(checkbox)) {
        return;
      }
      const key = checkbox.getAttribute("data-email-source-key");
      if (!key) {
        return;
      }
      if (checkbox.checked) {
        selectedEmailSourceKeys.add(String(key));
      } else {
        selectedEmailSourceKeys.delete(String(key));
      }
      renderEmails();
    });

    async function editIntelxHit(hitKey) {
      const current = getIntelxHitByKey(hitKey);
      if (!current) {
        setIntelxMessage("IntelX строка не найдена", "error");
        return;
      }

      const currentFileName = String(current.hit.fileName || "");
      const nextFileName = window.prompt("Имя файла IntelX", currentFileName);
      if (nextFileName === null) {
        return;
      }

      const nextLine = window.prompt("Найденная строка", current.hit.line || "");
      if (nextLine === null) {
        return;
      }

      setActionButtonsDisabled(true);
      setIntelxMessage("", "");
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/intelx-leaks/hit`, {
          method: "PUT",
          body: {
            ...current.ref,
            fileName: nextFileName,
            line: nextLine,
          },
        });
        intelxData = payload && payload.result ? payload.result : intelxData;
        renderIntelx();
        setIntelxMessage("IntelX строка обновлена", "success");
      } catch (error) {
        setIntelxMessage(friendlyError(error, "Не удалось изменить IntelX строку"), "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    }

    async function deleteIntelxHits(hitKeys) {
      const refs = Array.from(new Set(hitKeys)).map(parseIntelxHitKey).filter(Boolean);
      if (!refs.length) {
        setIntelxMessage("Выберите хотя бы одну IntelX строку", "error");
        return;
      }

      if (!window.confirm(`Удалить IntelX строки: ${refs.length}?`)) {
        return;
      }

      setActionButtonsDisabled(true);
      setIntelxMessage("", "");
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/intelx-leaks/delete`, {
          method: "POST",
          body: { hits: refs },
        });
        intelxData = payload && payload.result ? payload.result : intelxData;
        selectedIntelxHitKeys.clear();
        renderIntelx();
        setIntelxMessage(`Удалено IntelX строк: ${Number(payload && payload.deleted) || refs.length}`, "success");
      } catch (error) {
        setIntelxMessage(friendlyError(error, "Не удалось удалить IntelX строки"), "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    }

    intelxTableRoot.addEventListener("click", (event) => {
      const editButton = closestAction(event.target, "edit-intelx-hit");
      if (editButton && intelxTableRoot.contains(editButton)) {
        void editIntelxHit(editButton.getAttribute("data-hit-key"));
        return;
      }

      const deleteButton = closestAction(event.target, "delete-intelx-hit");
      if (deleteButton && intelxTableRoot.contains(deleteButton)) {
        void deleteIntelxHits([deleteButton.getAttribute("data-hit-key")]);
      }
    });

    intelxTableRoot.addEventListener("change", (event) => {
      const sectionToggle = closestAction(event.target, "intelx-select-search");
      if (sectionToggle && intelxTableRoot.contains(sectionToggle)) {
        const searchIndex = Number.parseInt(sectionToggle.getAttribute("data-search-index") || "", 10);
        const search = Array.isArray(intelxData?.searches) ? intelxData.searches[searchIndex] : null;
        const hits = Array.isArray(search?.hits) ? search.hits : [];
        hits.forEach((_hit, hitIndex) => {
          const key = `${searchIndex}:${hitIndex}`;
          if (sectionToggle.checked) {
            selectedIntelxHitKeys.add(key);
          } else {
            selectedIntelxHitKeys.delete(key);
          }
        });
        renderIntelx();
        return;
      }

      const checkbox = closestAction(event.target, "toggle-intelx-hit-select");
      if (!checkbox || !intelxTableRoot.contains(checkbox)) {
        return;
      }
      const key = checkbox.getAttribute("data-hit-key");
      if (!key) {
        return;
      }
      if (checkbox.checked) {
        selectedIntelxHitKeys.add(String(key));
      } else {
        selectedIntelxHitKeys.delete(String(key));
      }
      renderIntelx();
    });

    runPassiveAllBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/scan`,
        "Полный скан поставлен в очередь",
        { scope: "all" },
      );
    });

    runWhoisBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/whois-task`,
        "Задача WHOIS поставлена в очередь",
        {},
      );
    });

    runWebarchiveBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/webarchive-task`,
        "Задача WebArchive поставлена в очередь",
        {},
      );
    });

    runIntelxBtn.addEventListener("click", () => {
      const body = buildIntelxTaskBody();
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/intelx-task`,
        body.customQuery ? "Задача IntelX с кастомным запросом поставлена в очередь" : "Задача IntelX поставлена в очередь",
        body,
      );
    });

    runsExportCsvBtn.addEventListener("click", exportRunsCsv);
    subdomainsExportTableCsvBtn.addEventListener("click", exportSubdomainsTableCsv);
    whoisExportCsvBtn.addEventListener("click", exportWhoisCsv);
    vtDeepExportCsvBtn.addEventListener("click", exportVtDeepCsv);
    webarchiveExportCsvBtn.addEventListener("click", exportWebArchiveCsv);
    dorkStatsExportCsvBtn.addEventListener("click", exportDorkStatsCsv);
    intelxExportCsvBtn.addEventListener("click", exportIntelxCsv);

    function openDork(engine, query) {
      if (!primaryDomain || !query) {
        setActionMessage("Добавьте домен в проект для открытия дорка", "error");
        return;
      }

      const url = engine === "yandex"
        ? `https://yandex.ru/search/?text=${encodeURIComponent(query)}`
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    }

    openGoogleDorkBtn.addEventListener("click", () => {
      openDork("google", `site:${primaryDomain}`);
    });

    openGoogleSubdomainDorkBtn.addEventListener("click", () => {
      openDork("google", `site:*.${primaryDomain}`);
    });

    openYandexDorkBtn.addEventListener("click", () => {
      openDork("yandex", `site:${primaryDomain}`);
    });

    openYandexSubdomainDorkBtn.addEventListener("click", () => {
      openDork("yandex", `site:*.${primaryDomain}`);
    });

    if (subdomainsSearchInput) {
      subdomainsSearchInput.addEventListener("input", () => {
        scheduleSubdomainsSearchFilter();
      });
    }

    tabSubdomainsBtn.addEventListener("click", () => {
      activeDataTab = "subdomains";
      renderDataTab();
      renderActiveDataTabContent();
    });

    tabWhoisBtn.addEventListener("click", () => {
      activeDataTab = "whois";
      renderDataTab();
      renderActiveDataTabContent();
      void refreshWhoisInfo();
    });

    tabWebarchiveBtn.addEventListener("click", () => {
      activeDataTab = "webarchive";
      renderDataTab();
      renderActiveDataTabContent();
      if (!webarchiveData) {
        void refreshWebArchiveInfo();
      }
    });

    tabDorkStatsBtn.addEventListener("click", () => {
      activeDataTab = "dorkStats";
      renderDataTab();
      renderActiveDataTabContent();
      if (!dorkStatsData) {
        void refreshDorkStatsInfo();
      }
    });

    tabEmailsBtn.addEventListener("click", () => {
      activeDataTab = "emails";
      renderDataTab();
      renderActiveDataTabContent();
      if (!emailData) {
        void refreshEmailsInfo();
      }
    });

    tabVtDeepBtn.addEventListener("click", () => {
      activeDataTab = "vtdeep";
      renderDataTab();
      renderActiveDataTabContent();
      if (!vtDeepData) {
        void refreshVtDeepInfo();
      }
    });

    tabIntelxBtn.addEventListener("click", () => {
      activeDataTab = "intelx";
      renderDataTab();
      renderActiveDataTabContent();
      if (!intelxData) {
        void refreshIntelxInfo();
      }
    });

    vtDeepLoadBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/vt-deep-task`,
        "Задача VT Deep поставлена в очередь",
        {},
      );
    });

    webarchiveLoadBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/webarchive-task`,
        "Задача WebArchive поставлена в очередь",
        {},
      );
    });

    webarchiveRefreshMetadataBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/webarchive-metadata-task`,
        "Переизвлечение метаданных WebArchive поставлено в очередь",
        {},
      );
    });

    dorkStatsLoadBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/dork-stats-task`,
        "Сбор статистики дорков поставлен в очередь",
        {},
      );
    });

    emailsRefreshBtn.addEventListener("click", () => {
      void refreshEmailsInfo();
    });

    emailsAddBtn.addEventListener("click", async () => {
      const email = window.prompt("Новый email для УЗ");
      if (email === null) {
        return;
      }
      emailsAddBtn.disabled = true;
      setEmailsMessage("", "");
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/emails`, {
          method: "POST",
          body: { email },
        });
        emailData = payload && payload.result ? payload.result : emailData;
        renderEmails();
        setEmailsMessage("УЗ добавлена", "success");
      } catch (error) {
        setEmailsMessage(friendlyError(error, "Не удалось добавить УЗ"), "error");
      } finally {
        emailsAddBtn.disabled = false;
      }
    });

    emailsDeleteSelectedBtn.addEventListener("click", async () => {
      if (!selectedEmailSourceKeys.size) {
        return;
      }
      const confirmed = window.confirm(`Удалить выбранные emails: ${selectedEmailSourceKeys.size}?`);
      if (!confirmed) {
        return;
      }
      emailsDeleteSelectedBtn.disabled = true;
      setEmailsMessage("", "");
      try {
        const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/emails/delete`, {
          method: "POST",
          body: { sourceKeys: Array.from(selectedEmailSourceKeys) },
        });
        selectedEmailSourceKeys.clear();
        emailData = payload && payload.result ? payload.result : emailData;
        renderEmails();
        setEmailsMessage("Выбранные УЗ удалены", "success");
      } catch (error) {
        setEmailsMessage(friendlyError(error, "Не удалось удалить УЗ"), "error");
      } finally {
        emailsDeleteSelectedBtn.disabled = false;
      }
    });

    emailsEditSelectedBtn.addEventListener("click", async () => {
      if (selectedEmailSourceKeys.size !== 1) {
        return;
      }
      const sourceKey = Array.from(selectedEmailSourceKeys)[0];
      const current = Array.isArray(emailData?.emails)
        ? emailData.emails.find((item) => String(item.sourceKey || "") === String(sourceKey))
        : null;
      const nextEmail = window.prompt("Изменить email УЗ", current?.email || "");
      if (nextEmail === null) {
        return;
      }
      emailsEditSelectedBtn.disabled = true;
      setEmailsMessage("", "");
      try {
        const payload = await api(
          `/api/projects/${encodeURIComponent(projectId)}/emails/${encodeURIComponent(sourceKey)}`,
          { method: "PUT", body: { email: nextEmail } },
        );
        emailData = payload && payload.result ? payload.result : emailData;
        renderEmails();
        setEmailsMessage("УЗ обновлена", "success");
      } catch (error) {
        setEmailsMessage(friendlyError(error, "Не удалось изменить УЗ"), "error");
      } finally {
        emailsEditSelectedBtn.disabled = false;
      }
    });

    emailsExportCsvBtn.addEventListener("click", () => {
      const rows = Array.isArray(emailData?.emails) ? emailData.emails : [];
      if (!rows.length) {
        setEmailsMessage("Нет данных УЗ для экспорта", "error");
        return;
      }

      const csvRows = [
        ["email", "sources", "intelx_terms", "webarchive_hosts", "webarchive_authors", "webarchive_editors", "webarchive_titles", "webarchive_companies", "intelx_snippets", "whois"].join(";"),
        ...rows.map((item) =>
          [
            item.email || "",
            Array.isArray(item.sources) ? item.sources.join(",") : "",
            Array.isArray(item.intelxTerms) ? item.intelxTerms.join(",") : "",
            Array.isArray(item.webarchiveHosts) ? item.webarchiveHosts.join(",") : "",
            Array.isArray(item.webarchiveAuthors) ? item.webarchiveAuthors.join(",") : "",
            Array.isArray(item.webarchiveEditors) ? item.webarchiveEditors.join(",") : "",
            Array.isArray(item.webarchiveTitles) ? item.webarchiveTitles.join(",") : "",
            Array.isArray(item.webarchiveCompanies) ? item.webarchiveCompanies.join(",") : "",
            Array.isArray(item.intelxSnippets) ? item.intelxSnippets.join(" | ") : "",
            item.whois ? "1" : "0",
          ]
            .map((value) => `"${String(value).replace(/"/g, '""')}"`)
            .join(";"),
        ),
      ];

      downloadTextFile(
        `${projectId}-accounts.csv`,
        `\uFEFF${csvRows.join("\n")}\n`,
        "text/csv;charset=utf-8",
      );
      setEmailsMessage("УЗ экспортированы в CSV", "success");
    });

    intelxLoadBtn.addEventListener("click", () => {
      const body = buildIntelxTaskBody();
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/intelx-task`,
        body.customQuery ? "Задача IntelX с кастомным запросом поставлена в очередь" : "Задача IntelX поставлена в очередь",
        body,
      );
    });

    intelxEditSelectedBtn.addEventListener("click", () => {
      if (selectedIntelxHitKeys.size !== 1) {
        setIntelxMessage("Выберите одну IntelX строку для изменения", "error");
        return;
      }
      void editIntelxHit(Array.from(selectedIntelxHitKeys)[0]);
    });

    intelxDeleteSelectedBtn.addEventListener("click", () => {
      void deleteIntelxHits(Array.from(selectedIntelxHitKeys));
    });

    runResolveFastBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/resolve`,
        "DNS-резолв поставлен в очередь (быстрый)",
        { scope: "fast" },
      );
    });

    runResolveExtendedBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/resolve`,
        "DNS-резолв поставлен в очередь (расширенный)",
        { scope: "extended" },
      );
    });

    exportDomainIpCsvBtn.addEventListener("click", async () => {
      exportDomainIpCsvBtn.disabled = true;
      setActionMessage("", "");
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export/domain-ip.csv`, {
          method: "GET",
          credentials: "same-origin",
        });
        if (!response.ok) {
          const text = await response.text();
          let message = `Экспорт не удался (${response.status})`;
          try {
            const payload = text ? JSON.parse(text) : null;
            if (payload && typeof payload.error === "string") {
              message = payload.error;
            }
          } catch {
            // keep fallback message
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") || "";
        const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
        const fileName = fileNameMatch ? fileNameMatch[1] : `${getProjectFileStem(project)}-domain-ip.csv`;
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(url);
        setActionMessage("CSV экспортирован", "success");
      } catch (error) {
        setActionMessage(friendlyError(error, "Не удалось экспортировать CSV"), "error");
      } finally {
        exportDomainIpCsvBtn.disabled = false;
      }
    });

    deleteProjectBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Удалить этот проект и все связанные данные (поддомены, DNS-записи, историю запусков)? Это действие нельзя отменить.",
      );

      if (!confirmed) {
        return;
      }

      setActionButtonsDisabled(true);
      setActionMessage("", "");

      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
        navigate("/");
      } catch (error) {
        setActionButtonsDisabled(false);
        setActionMessage(friendlyError(error, "Не удалось удалить проект"), "error");
      }
    });

    projectDomainForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const domain = projectDomainInput.value.trim();
      if (!domain) {
        setActionMessage("Домен обязателен", "error");
        return;
      }

      projectDomainSubmit.disabled = true;
      setActionMessage("", "");
      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}/domains`, {
          method: "POST",
          body: { domain },
        });
        projectDomainInput.value = "";
        setActionMessage("Домен добавлен в проект", "success");
        await renderProjectPage(projectId);
      } catch (error) {
        setActionMessage(friendlyError(error, "Не удалось добавить домен"), "error");
      } finally {
        projectDomainSubmit.disabled = false;
      }
    });

    subdomainCreateForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const host = subdomainCreateHostInput.value.trim();
      if (!host) {
        setSubdomainMessage("Хост обязателен", "error");
        return;
      }

      subdomainCreateBtn.disabled = true;
      setSubdomainMessage("", "");
      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}/subdomains`, {
          method: "POST",
          body: { host },
        });
        subdomainCreateHostInput.value = "";
        setSubdomainMessage("Поддомен добавлен", "success");
        await refreshSubdomains(true);
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось добавить поддомен"), "error");
      } finally {
        subdomainCreateBtn.disabled = false;
      }
    });

    subdomainDeleteAllBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Удалить все поддомены в этом проекте (кроме корневого домена)?",
      );
      if (!confirmed) {
        return;
      }

      subdomainDeleteAllBtn.disabled = true;
      setSubdomainMessage("", "");
      try {
        const result = await api(`/api/projects/${encodeURIComponent(projectId)}/subdomains`, {
          method: "DELETE",
        });
        const deleted = Number(result && result.deleted) || 0;
        setSubdomainMessage(`Удалено ${deleted} поддоменов`, "success");
        await refreshSubdomains(true);
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось удалить поддомены"), "error");
      } finally {
        subdomainDeleteAllBtn.disabled = false;
      }
    });

    resolveSelectedBtn.addEventListener("click", async () => {
      const selectedIds = Array.from(selectedSubdomainIds);
      if (!selectedIds.length) {
        setSubdomainMessage("Выберите хотя бы один хост", "error");
        return;
      }
      resolveSelectedBtn.disabled = true;
      setSubdomainMessage("", "");
      try {
        await api(`/api/projects/${encodeURIComponent(projectId)}/resolve-selected`, {
          method: "POST",
          body: { scope: "fast", subdomainIds: selectedIds },
        });
        setSubdomainMessage(`Резолв выбранных поставлен в очередь: ${selectedIds.length}`, "success");
        selectedSubdomainIds.clear();
        renderSubdomains();
        await refreshRuns();
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось поставить резолв выбранных в очередь"), "error");
      } finally {
        resolveSelectedBtn.disabled = selectedSubdomainIds.size === 0;
      }
    });

    deleteSelectedBtn.addEventListener("click", async () => {
      const selectedIds = Array.from(selectedSubdomainIds);
      if (!selectedIds.length) {
        setSubdomainMessage("Выберите хотя бы один хост", "error");
        return;
      }

      const confirmed = window.confirm(`Удалить выбранные поддомены: ${selectedIds.length}?`);
      if (!confirmed) {
        return;
      }

      deleteSelectedBtn.disabled = true;
      setSubdomainMessage("", "");
      try {
        const result = await api(`/api/projects/${encodeURIComponent(projectId)}/subdomains/delete-selected`, {
          method: "POST",
          body: { subdomainIds: selectedIds },
        });
        const deleted = Number(result && result.deleted) || 0;
        setSubdomainMessage(`Удалено выбранных: ${deleted}`, "success");
        selectedSubdomainIds.clear();
        await refreshSubdomains(true);
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось удалить выбранные"), "error");
      } finally {
        deleteSelectedBtn.disabled = selectedSubdomainIds.size === 0;
      }
    });

    exportSelectedCsvBtn.addEventListener("click", async () => {
      const selectedIds = Array.from(selectedSubdomainIds);
      if (!selectedIds.length) {
        setSubdomainMessage("Выберите хотя бы один хост", "error");
        return;
      }

      exportSelectedCsvBtn.disabled = true;
      setSubdomainMessage("", "");
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export/domain-ip-selected.csv`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subdomainIds: selectedIds }),
        });
        if (!response.ok) {
          const text = await response.text();
          let message = `Экспорт не удался (${response.status})`;
          try {
            const payload = text ? JSON.parse(text) : null;
            if (payload && typeof payload.error === "string") {
              message = payload.error;
            }
          } catch {
            // keep fallback message
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") || "";
        const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
        const fileName = fileNameMatch ? fileNameMatch[1] : `${getProjectFileStem(project)}-selected-domain-ip.csv`;
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(url);
        setSubdomainMessage("Выбранные данные экспортированы в CSV", "success");
      } catch (error) {
        setSubdomainMessage(friendlyError(error, "Не удалось экспортировать выбранные данные в CSV"), "error");
      } finally {
        exportSelectedCsvBtn.disabled = selectedSubdomainIds.size === 0;
      }
    });

    runsSignature = createRunsSignature(runs);
    subdomainsSignature = "";
    runsTimelineSignature = "";
    renderRuns(true);
    renderSubdomains();
    renderDataTab();
    void refreshSubdomains(true).catch((error) => {
      if (disposed) {
        return;
      }
      setSubdomainMessage(friendlyError(error, "Не удалось загрузить поддомены"), "error");
    });

    runsLogRoot.addEventListener("scroll", lockRunsRenderDuringInteraction, { passive: true });
    runsLogRoot.addEventListener("wheel", lockRunsRenderDuringInteraction, { passive: true });
    runsLogRoot.addEventListener("touchmove", lockRunsRenderDuringInteraction, { passive: true });

    let runsPollTimer = null;

    function scheduleRunsPoll(delayMs) {
      runsPollTimer = setTimeout(async () => {
        if (disposed) {
          return;
        }

        if (!document.hidden) {
          await refreshRuns();
        }

        const hasActiveRuns = runs.some((run) => ACTIVE_STATUSES.has(run.status));
        scheduleRunsPoll(hasActiveRuns ? 3000 : 10000);
      }, delayMs);
    }

    scheduleRunsPoll(3000);

    setPageCleanup(() => {
      disposed = true;
      if (runsRenderUnlockTimer) {
        clearTimeout(runsRenderUnlockTimer);
      }
      if (subdomainsFilterTimer) {
        clearTimeout(subdomainsFilterTimer);
      }
      if (subdomainsFilterFrame) {
        cancelAnimationFrame(subdomainsFilterFrame);
      }
      if (timelineClusterize && typeof timelineClusterize.destroy === "function") {
        timelineClusterize.destroy(true);
      }
      if (runsPollTimer) {
        clearTimeout(runsPollTimer);
      }
    });
  }

  async function renderProvidersPage() {
    let payload;

    try {
      payload = await api("/api/settings/providers");
    } catch (error) {
      appEl.innerHTML = `
        <section class="panel">${renderErrorBanner(
          friendlyError(error, "Не удалось загрузить провайдеров"),
        )}</section>
      `;
      return;
    }

    const providers = Array.isArray(payload && payload.providers)
      ? payload.providers
      : [];

    const rows = providers
      .map(
        (provider) => {
          const tokenMeta = provider.hasToken
            ? (provider.provider === "intelx"
              ? `Да${provider.tokenPartsCount > 1 ? ` (${provider.tokenPartsCount} ключей)` : ""}`
              : "Да")
            : "Нет";
          const intelxKeyItems = provider.provider === "intelx"
            ? Array.from({ length: Number(provider.tokenPartsCount) || 0 }, (_item, index) => `
              <div class="intelx-key-item">
                <span class="mono">Key ${index + 1}</span>
                <button class="btn btn-ghost intelx-key-remove" data-key-index="${index}" type="button">Убрать</button>
              </div>
            `).join("")
            : "";

          return `
          <tr class="provider-row ${provider.provider === "intelx" ? "provider-row-intelx" : ""}" data-provider="${escapeHtml(provider.provider)}">
            <td>
              <div><strong>${escapeHtml(provider.title || provider.provider)}</strong></div>
              <div class="hint mono">${escapeHtml(provider.provider)}</div>
            </td>
            <td>${escapeHtml(provider.description || "-")}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" class="provider-enabled" ${provider.enabled ? "checked" : ""} />
                Включен
              </label>
            </td>
            <td>
              <div>${escapeHtml(tokenMeta)}</div>
            </td>
            <td>
              ${provider.provider === "intelx"
                ? `
                  <div class="intelx-stack">
                    <section class="intelx-block">
                      <div class="intelx-block-head">
                        <strong>Ключи</strong>
                        <span class="hint">${Number(provider.tokenPartsCount) || 0}</span>
                      </div>
                      <div class="intelx-key-list">
                        ${intelxKeyItems || '<div class="hint">Ключи пока не добавлены.</div>'}
                      </div>
                    </section>
                    <section class="intelx-block intelx-block-add">
                      <div class="intelx-block-head">
                        <strong>Добавить ключ</strong>
                      </div>
                      <div class="row wrap intelx-key-input-row">
                        <input class="text-input intelx-key-input" type="password" placeholder="Новый IntelX key" />
                        <button class="btn btn-secondary intelx-key-add" type="button">Добавить</button>
                      </div>
                    </section>
                  </div>
                `
                : `<input class="text-input provider-token" type="text" placeholder="Новый токен (необязательно)" />`}
            </td>
            <td>
              ${provider.provider === "intelx"
                ? `
                  <div class="intelx-stack">
                    <section class="intelx-block intelx-block-actions">
                      <div class="intelx-block-head">
                        <strong>Действия</strong>
                      </div>
                  <div class="row row-no-margin wrap intelx-actions-row">
                        <button class="btn btn-primary provider-save" type="button">Сохранить</button>
                        <button class="btn btn-ghost provider-clear" type="button">Очистить</button>
                        <button class="btn btn-ghost provider-check-limit" type="button">Проверить токены</button>
                      </div>
                      <div class="hint">Обновлено: ${escapeHtml(formatDate(provider.updatedAt))}</div>
                      <div class="hint provider-row-message"></div>
                    </section>
                    <section class="intelx-block intelx-block-usage">
                      <div class="intelx-block-head">
                        <strong>Квоты</strong>
                      </div>
                      <div class="provider-row-progress"></div>
                    </section>
                  </div>
                `
                : `
                  <div class="row row-no-margin wrap">
                    <button class="btn btn-primary provider-save" type="button">Сохранить</button>
                    <button class="btn btn-ghost provider-clear" type="button">Очистить токен</button>
                    <button class="btn btn-ghost provider-check-limit" type="button">Проверить лимит</button>
                  </div>
                  <div class="hint">Обновлено: ${escapeHtml(formatDate(provider.updatedAt))}</div>
                  <div class="provider-row-progress"></div>
                  <div class="hint provider-row-message"></div>
                `}
            </td>
          </tr>
        `;
        },
      )
      .join("");

    appEl.innerHTML = `
      <div class="stack-xl">
        <section class="panel hero">
          <h1>Настройки провайдеров</h1>
          <p>Токены шифруются при хранении (AES-256-GCM в SQLite).</p>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Провайдеры</h2>
            <p>${providers.length} настроенных провайдеров</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Провайдер</th>
                  <th>Описание</th>
                  <th>Включен</th>
                  <th>Токен</th>
                  <th>Обновить токен</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    const providerRows = appEl.querySelectorAll(".provider-row");

    providerRows.forEach((row) => {
      const provider = row.getAttribute("data-provider");
      const enabledInput = row.querySelector(".provider-enabled");
      const tokenInput = row.querySelector(".provider-token");
      const intelxKeyInput = row.querySelector(".intelx-key-input");
      const intelxKeyAddButton = row.querySelector(".intelx-key-add");
      const intelxKeyRemoveButtons = row.querySelectorAll(".intelx-key-remove");
      const saveButton = row.querySelector(".provider-save");
      const clearButton = row.querySelector(".provider-clear");
      const checkLimitButton = row.querySelector(".provider-check-limit");
      const rowProgress = row.querySelector(".provider-row-progress");
      const rowMessage = row.querySelector(".provider-row-message");

      function setRowMessage(message, kind) {
        rowMessage.textContent = message || "";
        if (!message) {
          rowMessage.style.color = "";
          return;
        }

        rowMessage.style.color = kind === "error" ? "#8a1919" : "#115e59";
      }

      function setRowProgress(markup = "") {
        if (rowProgress) {
          rowProgress.innerHTML = markup;
        }
      }

      function setRowBusy(disabled) {
        saveButton.disabled = disabled;
        clearButton.disabled = disabled;
        checkLimitButton.disabled = disabled;
        if (intelxKeyInput) {
          intelxKeyInput.disabled = disabled;
        }
        if (intelxKeyAddButton) {
          intelxKeyAddButton.disabled = disabled;
        }
        intelxKeyRemoveButtons.forEach((button) => {
          button.disabled = disabled;
        });
      }

      async function save(clearToken) {
        setRowBusy(true);
        setRowMessage("", "");
        setRowProgress("");

        try {
          const body = {
            provider,
            enabled: Boolean(enabledInput.checked),
          };

          if (clearToken) {
            body.clearToken = true;
          } else {
            const token = tokenInput.value.trim();
            if (token) {
              body.token = token;
            }
          }

          await api("/api/settings/providers", {
            method: "PUT",
            body,
          });

          setRowMessage("Сохранено", "success");
          tokenInput.value = "";
          await renderProvidersPage();
        } catch (error) {
          setRowMessage(friendlyError(error, "Не удалось сохранить"), "error");
        } finally {
          setRowBusy(false);
        }
      }

      saveButton.addEventListener("click", () => {
        void save(false);
      });

      clearButton.addEventListener("click", () => {
        void save(true);
      });

      if (intelxKeyAddButton && intelxKeyInput) {
        intelxKeyAddButton.addEventListener("click", async () => {
          const key = intelxKeyInput.value.trim();
          if (!key) {
            setRowMessage("Введите IntelX key", "error");
            return;
          }

          setRowBusy(true);
          setRowMessage("", "");
          try {
            await api("/api/settings/providers/intelx/keys", {
              method: "POST",
              body: { key },
            });
            setRowMessage("IntelX key добавлен", "success");
            await renderProvidersPage();
          } catch (error) {
            setRowMessage(friendlyError(error, "Не удалось добавить IntelX key"), "error");
          } finally {
            setRowBusy(false);
          }
        });
      }

      intelxKeyRemoveButtons.forEach((button) => {
        button.addEventListener("click", async () => {
          const keyIndex = button.getAttribute("data-key-index");
          if (keyIndex === null) {
            return;
          }

          setRowBusy(true);
          setRowMessage("", "");
          try {
            await api(`/api/settings/providers/intelx/keys/${encodeURIComponent(keyIndex)}`, {
              method: "DELETE",
            });
            setRowMessage("IntelX key удален", "success");
            await renderProvidersPage();
          } catch (error) {
            setRowMessage(friendlyError(error, "Не удалось удалить IntelX key"), "error");
          } finally {
            setRowBusy(false);
          }
        });
      });

      checkLimitButton.addEventListener("click", async () => {
        setRowBusy(true);
        setRowMessage("Проверка...", "success");
        setRowProgress("");

        try {
          const payload = await api("/api/settings/providers/check-limit", {
            method: "POST",
            body: { provider },
          });
          const result = payload && payload.result ? payload.result : null;
          if (provider === "intelx") {
            setRowMessage("Проверка IntelX завершена", "success");
            setRowProgress(buildIntelxQuotaMarkup(result));
          } else {
            setRowMessage(formatProviderCheckMessage(provider, result), "success");
          }
        } catch (error) {
          setRowMessage(friendlyError(error, "Не удалось проверить лимит"), "error");
        } finally {
          setRowBusy(false);
        }
      });
    });
  }

  async function renderAdminPage() {
    let payload;

    try {
      payload = await api("/api/admin/users");
    } catch (error) {
      appEl.innerHTML = `
        <section class="panel">${renderErrorBanner(
          friendlyError(error, "Не удалось загрузить пользователей"),
        )}</section>
      `;
      return;
    }

    const users = Array.isArray(payload && payload.users) ? payload.users : [];

    const rows = users
      .map(
        (user) => `
          <tr class="admin-user-row" data-user-id="${escapeHtml(user.id)}">
            <td>
              <div>${escapeHtml(user.email)}</div>
              <div class="hint mono">${escapeHtml(user.id)}</div>
            </td>
            <td>
              <select class="text-input user-role user-role-select">
                <option value="USER" ${user.role === "USER" ? "selected" : ""}>USER</option>
                <option value="ADMIN" ${user.role === "ADMIN" ? "selected" : ""}>ADMIN</option>
              </select>
            </td>
            <td>
              <label class="toggle">
                <input type="checkbox" class="user-active" ${user.isActive ? "checked" : ""} />
                Активен
              </label>
            </td>
            <td>
              <input class="text-input user-password" type="password" minlength="8" placeholder="Новый пароль (необязательно)" />
            </td>
            <td>
              <div class="row row-no-margin wrap">
                <button class="btn btn-primary user-update" type="button">Обновить</button>
                <button class="btn btn-danger user-delete" type="button">Удалить</button>
              </div>
              <div class="hint user-row-message"></div>
            </td>
          </tr>
        `,
      )
      .join("");

    appEl.innerHTML = `
      <div class="stack-xl">
        <section class="panel hero">
          <h1>Пользователи админки</h1>
          <p>Создавайте и управляйте учетными записями с ролевым доступом.</p>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Создать пользователя</h2>
            <p>Только ADMIN может создавать пользователей</p>
          </div>
          <form id="create-user-form">
            <div id="create-user-message"></div>
            <div class="auth-grid">
              <div class="field">
                <label for="create-user-email">Почта</label>
                <input id="create-user-email" class="text-input" type="email" required />
              </div>
              <div class="field">
                <label for="create-user-password">Пароль</label>
                <input id="create-user-password" class="text-input" type="password" minlength="8" required />
              </div>
              <div class="field">
                <label for="create-user-role">Роль</label>
                <select id="create-user-role" class="text-input">
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-primary" id="create-user-submit" type="submit">Создать пользователя</button>
            </div>
          </form>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Пользователи</h2>
            <p>${users.length} всего пользователей</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Почта</th>
                  <th>Роль</th>
                  <th>Активен</th>
                  <th>Сброс пароля</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    const createForm = document.getElementById("create-user-form");
    const createSubmit = document.getElementById("create-user-submit");
    const createMessage = document.getElementById("create-user-message");

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      createSubmit.disabled = true;
      createMessage.innerHTML = "";

      try {
        const email = document.getElementById("create-user-email").value.trim();
        const password = document.getElementById("create-user-password").value;
        const role = document.getElementById("create-user-role").value;

        await api("/api/admin/users", {
          method: "POST",
          body: { email, password, role },
        });

        createMessage.innerHTML = renderSuccessBanner("Пользователь создан");
        await renderAdminPage();
      } catch (error) {
        createMessage.innerHTML = renderErrorBanner(
          friendlyError(error, "Не удалось создать пользователя"),
        );
      } finally {
        createSubmit.disabled = false;
      }
    });

    const userRows = appEl.querySelectorAll(".admin-user-row");

    userRows.forEach((row) => {
      const userId = row.getAttribute("data-user-id");
      const roleSelect = row.querySelector(".user-role");
      const activeInput = row.querySelector(".user-active");
      const passwordInput = row.querySelector(".user-password");
      const updateButton = row.querySelector(".user-update");
      const deleteButton = row.querySelector(".user-delete");
      const rowMessage = row.querySelector(".user-row-message");

      updateButton.addEventListener("click", async () => {
        updateButton.disabled = true;
        if (deleteButton) {
          deleteButton.disabled = true;
        }
        rowMessage.textContent = "";

        try {
          const body = {
            role: roleSelect.value,
            isActive: Boolean(activeInput.checked),
          };

          const password = passwordInput.value;
          if (password.trim()) {
            body.password = password;
          }

          await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: "PUT",
            body,
          });

          rowMessage.textContent = "Сохранено";
          rowMessage.style.color = "#7ceccc";
          passwordInput.value = "";
          await renderAdminPage();
        } catch (error) {
          rowMessage.textContent = friendlyError(error, "Не удалось обновить");
          rowMessage.style.color = "#ff9dbf";
        } finally {
          updateButton.disabled = false;
          if (deleteButton) {
            deleteButton.disabled = false;
          }
        }
      });

      if (deleteButton) {
        deleteButton.addEventListener("click", async () => {
          const confirmed = window.confirm("Удалить эту учетную запись? Это действие нельзя отменить.");
          if (!confirmed) {
            return;
          }

          updateButton.disabled = true;
          deleteButton.disabled = true;
          rowMessage.textContent = "";

          try {
            await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
              method: "DELETE",
            });
            await loadCurrentUser();
            renderTopbar();
            if (!state.user) {
              navigate("/login", { replace: true });
              return;
            }
            await renderAdminPage();
          } catch (error) {
            rowMessage.textContent = friendlyError(error, "Не удалось удалить");
            rowMessage.style.color = "#ff9dbf";
            updateButton.disabled = false;
            deleteButton.disabled = false;
          }
        });
      }
    });
  }

  function renderNotFound() {
    appEl.innerHTML = `
      <section class="panel hero">
        <h1>Не найдено</h1>
        <p>Страница не существует.</p>
        <div class="row"><a class="btn btn-primary" href="/" data-link>На главную</a></div>
      </section>
    `;
  }

  function matchProjectRoute(path) {
    const match = path.match(/^\/projects\/([^/]+)$/);
    if (!match) {
      return null;
    }

    return decodeURIComponent(match[1]);
  }

  async function renderRoute() {
    setPageCleanup(null);
    renderLoading();

    await loadCurrentUser();
    renderTopbar();

    const path = normalizePath(window.location.pathname);

    const isPublicRoute = path === "/login" || path === "/setup";
    const isProjectRoute = Boolean(matchProjectRoute(path));

    if (!state.user && !isPublicRoute) {
      navigate("/login", { replace: true });
      return;
    }

    if (state.user && (path === "/login" || path === "/setup")) {
      navigate("/", { replace: true });
      return;
    }

    if ((path === "/settings" || path === "/admin") && (!state.user || state.user.role !== "ADMIN")) {
      navigate("/", { replace: true });
      return;
    }

    if (path === "/login") {
      await renderLoginPage();
      return;
    }

    if (path === "/setup") {
      await renderSetupPage();
      return;
    }

    if (path === "/") {
      await renderProjectsPage();
      return;
    }

    if (path === "/settings") {
      await renderProvidersPage();
      return;
    }

    if (path === "/admin") {
      await renderAdminPage();
      return;
    }

    if (isProjectRoute) {
      await renderProjectPage(matchProjectRoute(path));
      return;
    }

    renderNotFound();
  }

  document.body.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link) {
      return;
    }

    if (link.target && link.target !== "_self") {
      return;
    }

    const href = link.getAttribute("href");
    if (!href || href.startsWith("http://") || href.startsWith("https://")) {
      return;
    }

    event.preventDefault();
    navigate(href);
  });

  window.addEventListener("popstate", () => {
    void renderRoute();
  });

  window.showAppPopup = (message, kind, options) => {
    showPopup(message, kind, options);
  };

  applyUi({ skipPersist: true });
  void renderRoute();
})();
