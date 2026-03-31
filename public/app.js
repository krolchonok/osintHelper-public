(function () {
  const appEl = document.getElementById("app");
  const navEl = document.getElementById("topbar-nav");
  const UI_MODE_STORAGE_KEY = "ui-mode";
  const UI_MODE_EFFECTS = "effects";
  const UI_MODE_LITE = "lite";

  const state = {
    user: null,
    pageCleanup: null,
    projectSearch: "",
    projectsFilterRenderer: null,
    projectSearchDebounceTimer: null,
    uiMode: readInitialUiMode(),
  };

  const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);
  const SUBDOMAINS_PAGE_SIZES = [100, 250, 500];
  const DEFAULT_SUBDOMAINS_PAGE_SIZE = SUBDOMAINS_PAGE_SIZES[0];
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

  function readInitialUiMode() {
    try {
      const value = String(window.localStorage.getItem(UI_MODE_STORAGE_KEY) || "")
        .trim()
        .toLowerCase();
      if (value === UI_MODE_LITE || value === UI_MODE_EFFECTS) {
        return value;
      }
    } catch {
      // ignore storage read failures
    }
    return UI_MODE_LITE;
  }

  function getUiModeToggleLabel(mode = state.uiMode) {
    return mode === UI_MODE_LITE ? "Легкий режим" : "Режим с эффектами";
  }

  function getUiModeToggleIcon(mode = state.uiMode) {
    return mode === UI_MODE_LITE ? ICON_EYE_OFF : ICON_EYE;
  }

  function buildUiModeToggleButton() {
    const label = getUiModeToggleLabel();
    return `<button type="button" id="ui-mode-toggle-btn" class="ui-mode-toggle" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-pressed="${state.uiMode === UI_MODE_EFFECTS ? "true" : "false"}">${getUiModeToggleIcon()}<span class="visually-hidden">${escapeHtml(label)}</span></button>`;
  }

  function applyUiMode(mode, options = {}) {
    const normalized = mode === UI_MODE_LITE ? UI_MODE_LITE : UI_MODE_EFFECTS;
    state.uiMode = normalized;

    document.body.classList.toggle("ui-mode-lite", normalized === UI_MODE_LITE);
    document.body.classList.toggle("ui-mode-effects", normalized === UI_MODE_EFFECTS);

    if (!options.skipPersist) {
      try {
        window.localStorage.setItem(UI_MODE_STORAGE_KEY, normalized);
      } catch {
        // ignore storage write failures
      }
    }

    const toggleButton = document.getElementById("ui-mode-toggle-btn");
    if (toggleButton) {
      const label = getUiModeToggleLabel(normalized);
      toggleButton.innerHTML = `${getUiModeToggleIcon(normalized)}<span class="visually-hidden">${escapeHtml(label)}</span>`;
      toggleButton.setAttribute("aria-label", label);
      toggleButton.setAttribute("title", label);
      toggleButton.setAttribute("aria-pressed", normalized === UI_MODE_EFFECTS ? "true" : "false");
    }

    if (options.notify) {
      showPopup(
        normalized === UI_MODE_LITE ? "Включен легкий режим" : "Включен режим с эффектами",
        "info",
        { timeoutMs: 2200 },
      );
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

    const uiModeButton = buildUiModeToggleButton();

    if (!state.user) {
      navEl.innerHTML = [uiModeButton, '<a href="/login" data-link>Вход</a>'].join("");
      const toggleButton = document.getElementById("ui-mode-toggle-btn");
      if (toggleButton) {
        toggleButton.addEventListener("click", () => {
          applyUiMode(state.uiMode === UI_MODE_LITE ? UI_MODE_EFFECTS : UI_MODE_LITE, { notify: true });
        });
      }
      return;
    }

    const searchValue = escapeHtml(state.projectSearch || "");
    const adminLinks =
      state.user.role === "ADMIN"
        ? '<a href="/settings" data-link>Провайдеры</a><a href="/admin" data-link>Админка</a>'
        : "";

    navEl.innerHTML = [
      uiModeButton,
      '<a href="/" data-link>Проекты</a>',
      adminLinks,
      `<input id="topbar-search" class="text-input topbar-search" type="search" placeholder="Поиск проектов..." aria-label="Поиск проектов" value="${searchValue}" />`,
      `<span class="session-user mono">${escapeHtml(state.user.email)}</span>`,
      `<span class="pill tiny">${escapeHtml(state.user.role)}</span>`,
      '<button type="button" id="logout-btn">Выход</button>',
    ].join("");

    const toggleButton = document.getElementById("ui-mode-toggle-btn");
    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        applyUiMode(state.uiMode === UI_MODE_LITE ? UI_MODE_EFFECTS : UI_MODE_LITE, { notify: true });
      });
    }

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
        const lead = `Покрытие для ${project.domain}: пассивные источники, DNS-резолв и история запусков.`;
        const domainsMeta = domains.length > 1
          ? `${domains.length} домена: ${domains.join(", ")}`
          : `${domains[0] || project.domain}`;

        return `
          <a class="project-card" href="/projects/${encodeURIComponent(project.id)}" data-link style="--card-stagger:${40 + ((index % 8) * 40)}ms">
            <div class="project-card-main">
              <div class="meta">
                <span>${escapeHtml(createdAt)}</span>
                <span class="pill tiny">${status}</span>
              </div>
              <div class="project-title mono">${escapeHtml(project.domain)}</div>
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
          <p>Создавайте проект на домен, запускайте пассивный скан и DNS-резолв, отслеживайте прогресс и историю.</p>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Добавить проекты</h2>
            <p>Форматы ввода: запятая, точка с запятой, новая строка</p>
          </div>
          <form id="bulk-project-form">
            <div id="bulk-project-message"></div>
            <textarea id="bulk-project-input" class="text-input" rows="4" placeholder="example.com\nexample.org"></textarea>
            <div class="row">
              <button class="btn btn-primary" id="bulk-project-submit" type="submit">Сохранить домены</button>
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
        ? allProjects.filter((project) =>
            formatProjectDomains(project).some((domain) => String(domain || "").toLowerCase().includes(searchNeedle)),
          )
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

    const form = document.getElementById("bulk-project-form");
    const submit = document.getElementById("bulk-project-submit");
    const messageEl = document.getElementById("bulk-project-message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("bulk-project-input").value;

      submit.disabled = true;
      messageEl.innerHTML = "";

      try {
        const result = await api("/api/projects/bulk", {
          method: "POST",
          body: { input },
        });

        messageEl.innerHTML = renderSuccessBanner(
          `Сохранено: создано ${result.created}, уже было ${result.existed}`,
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
              : run.taskKind === "DNS_RESOLVE_SELECTED"
                ? "DNS_RESOLVE_SELECTED"
              : run.type;
        const scopeLabel =
          run.taskKind === "WHOIS" || run.taskKind === "VT_DEEP" || run.taskKind === "DNS_RESOLVE_SELECTED"
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
        <div class="row wrap">
          <span class="hint">Показано ${start}-${end} из ${total}</span>
          <label class="hint">На странице
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
      <div class="row wrap">
        <span class="hint">Показано ${start}-${end} из ${total}</span>
        <label class="hint">На странице
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

  async function renderProjectPage(projectId) {
    let payload;
    let passiveSourcePayload = null;

    try {
      payload = await api(`/api/projects/${encodeURIComponent(projectId)}`);
      passiveSourcePayload = await api(`/api/projects/${encodeURIComponent(projectId)}/passive-sources`);
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
    let activeDataTab = "subdomains";
    const selectedSubdomainIds = new Set();
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
    let disposed = false;
    const passiveSources = Array.isArray(passiveSourcePayload && passiveSourcePayload.sources)
      ? passiveSourcePayload.sources
      : [];
    const passiveSourceOptions = passiveSources
      .map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(formatPassiveSourceLabel(source))}</option>`)
      .join("");
    const projectDomainsMarkup = projectDomains
      .map((domain) => `<span class="pill mono">${escapeHtml(domain)}</span>`)
      .join("");

    appEl.innerHTML = `
      <div id="project-page-root">
        <div class="project-column project-column-left">
          <section class="panel hero">
            <h1>${escapeHtml(project.domain)}</h1>
            <p>
              Поддомены: ${Number(project.counts && project.counts.subdomains) || 0}
              · DNS-записи: ${Number(project.counts && project.counts.dnsRecords) || 0}
              · Запуски: ${Number(project.counts && project.counts.runs) || 0}
            </p>
            <div class="row wrap">
              ${projectDomainsMarkup}
            </div>
            <form id="project-domain-form">
              <div class="row wrap">
                <input id="project-domain-input" class="text-input mono" type="text" placeholder="Добавить домен в этот проект" />
                <button class="btn btn-secondary" id="project-domain-submit" type="submit">Добавить домен</button>
              </div>
            </form>
          </section>

          <section class="panel" id="project-actions-panel">
            <div class="panel-header">
              <h2>Действия</h2>
            </div>
            <div class="row" id="project-actions-stack">
              <div class="action-group">
                <div class="action-group-head">
                  <div class="action-group-title">Пассивный скан</div>
                  <button
                    id="passive-scope-info-btn"
                    class="info-icon-btn"
                    type="button"
                    aria-label="Показать отличия типов пассивных сканов"
                    aria-expanded="false"
                    aria-controls="passive-scope-info"
                  >i</button>
                </div>
                <div id="passive-scope-info" class="passive-scope-info" hidden>
                  <ul class="passive-scope-list">
                    <li><span class="mono">base</span>: базовые web-источники без обязательных токенов.</li>
                    <li><span class="mono">all</span>: base + token-based источники + dork-источники.</li>
                  </ul>
                </div>
                <button class="btn btn-primary" id="run-passive-core-btn">Запустить пассивный скан (Base)</button>
                <button class="btn btn-ghost" id="run-passive-all-btn">Запустить пассивный скан (All)</button>
              </div>
              <div class="action-group">
                <div class="action-group-title">Отдельный провайдер</div>
                <select class="text-input mono" id="run-passive-provider-select">
                  ${passiveSourceOptions}
                </select>
                <button class="btn btn-secondary" id="run-passive-provider-btn">Запустить выбранный провайдер</button>
              </div>
              <div class="action-group">
                <div class="action-group-title">DNS и WHOIS</div>
                <button class="btn btn-ghost" id="run-whois-btn">WHOIS (корневой домен)</button>
                <button class="btn btn-secondary" id="run-resolve-fast-btn">DNS-резолв (быстрый)</button>
                <button class="btn btn-ghost" id="run-resolve-extended-btn">DNS-резолв (расширенный)</button>
              </div>
              <div class="action-group">
                <div class="action-group-title">Экспорт</div>
                <button class="btn btn-secondary" id="export-domain-ip-csv-btn">Экспорт CSV domain;ip</button>
              </div>
              <div class="action-group action-group-danger">
                <div class="action-group-title">Опасная зона</div>
                <button class="btn btn-danger" id="delete-project-btn">Удалить проект</button>
              </div>
            </div>
            <div id="project-action-message"></div>
          </section>
        </div>

        <div class="project-column project-column-right">
          <section class="panel">
            <div class="panel-header">
              <h2>Последние запуски</h2>
              <p id="runs-status-text">Автообновление каждые 3 с</p>
            </div>
            <div id="runs-table-root"></div>
            <div class="run-log" id="runs-log-root"></div>
            <div class="whois-block">
              <div class="panel-header">
                <h3>WHOIS</h3>
                <p>Снимок корневого домена</p>
              </div>
              <textarea id="whois-info-field" class="text-input mono" rows="4" readonly placeholder="Здесь появится WHOIS-информация"></textarea>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2>Данные</h2>
              <p id="subdomains-status-text">Автообновление каждые 3 с при активных запусках.</p>
            </div>
            <div class="row wrap">
              <button class="btn btn-primary" id="tab-subdomains-btn" type="button">Поддомены</button>
              <button class="btn btn-ghost" id="tab-vtdeep-btn" type="button">VT Deep</button>
            </div>
            <div id="subdomains-panel">
            <form id="subdomain-create-form">
              <div class="row wrap">
                <input id="subdomain-create-host" class="text-input mono" type="text" placeholder="new.${escapeHtml(project.domain)}" />
                <button class="btn btn-primary" id="subdomain-create-btn" type="submit">Добавить поддомен</button>
                <button class="btn btn-secondary" id="resolve-selected-btn" type="button">Резолв выбранных (быстрый)</button>
                <button class="btn btn-danger" id="delete-selected-btn" type="button">Удалить выбранные</button>
                <button class="btn btn-secondary" id="export-selected-csv-btn" type="button">Экспорт выбранных</button>
                <button class="btn btn-danger" id="subdomain-delete-all-btn" type="button">Удалить все</button>
              </div>
            </form>
            <div id="subdomain-action-message"></div>
            <div id="subdomains-table-root"></div>
            </div>
            <div id="vtdeep-panel" style="display:none">
              <div class="row wrap">
                <button class="btn btn-secondary" id="vtdeep-load-btn" type="button">Загрузить данные VT Deep</button>
              </div>
              <div id="vtdeep-action-message"></div>
              <div id="vtdeep-table-root"></div>
            </div>
          </section>
        </div>
      </div>
    `;

    const runPassiveCoreBtn = document.getElementById("run-passive-core-btn");
    const runPassiveAllBtn = document.getElementById("run-passive-all-btn");
    const runPassiveProviderSelect = document.getElementById("run-passive-provider-select");
    const runPassiveProviderBtn = document.getElementById("run-passive-provider-btn");
    const passiveScopeInfoBtn = document.getElementById("passive-scope-info-btn");
    const passiveScopeInfo = document.getElementById("passive-scope-info");
    const runWhoisBtn = document.getElementById("run-whois-btn");
    const runResolveFastBtn = document.getElementById("run-resolve-fast-btn");
    const runResolveExtendedBtn = document.getElementById("run-resolve-extended-btn");
    const exportDomainIpCsvBtn = document.getElementById("export-domain-ip-csv-btn");
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
    const tabVtDeepBtn = document.getElementById("tab-vtdeep-btn");
    const subdomainsPanel = document.getElementById("subdomains-panel");
    const vtDeepPanel = document.getElementById("vtdeep-panel");
    const subdomainCreateForm = document.getElementById("subdomain-create-form");
    const subdomainCreateHostInput = document.getElementById("subdomain-create-host");
    const subdomainCreateBtn = document.getElementById("subdomain-create-btn");
    const resolveSelectedBtn = document.getElementById("resolve-selected-btn");
    const deleteSelectedBtn = document.getElementById("delete-selected-btn");
    const exportSelectedCsvBtn = document.getElementById("export-selected-csv-btn");
    const subdomainDeleteAllBtn = document.getElementById("subdomain-delete-all-btn");
    const subdomainActionMessageEl = document.getElementById("subdomain-action-message");
    const vtDeepLoadBtn = document.getElementById("vtdeep-load-btn");
    const vtDeepActionMessageEl = document.getElementById("vtdeep-action-message");
    const vtDeepTableRoot = document.getElementById("vtdeep-table-root");

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

    function setPassiveScopeInfoOpen(isOpen) {
      if (!passiveScopeInfoBtn || !passiveScopeInfo) {
        return;
      }
      passiveScopeInfo.hidden = !isOpen;
      passiveScopeInfoBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    if (passiveScopeInfoBtn && passiveScopeInfo) {
      passiveScopeInfoBtn.addEventListener("click", () => {
        setPassiveScopeInfoOpen(passiveScopeInfo.hidden);
      });
    }

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

    function renderDataTab() {
      const showSubdomains = activeDataTab === "subdomains";
      subdomainsPanel.style.display = showSubdomains ? "" : "none";
      vtDeepPanel.style.display = showSubdomains ? "none" : "";
      tabSubdomainsBtn.className = showSubdomains ? "btn btn-primary" : "btn btn-ghost";
      tabVtDeepBtn.className = showSubdomains ? "btn btn-ghost" : "btn btn-primary";
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

    function renderRunsTable() {
      runsTableRoot.innerHTML = buildRunsTable(runs, selectedRunId);

      const hasActive = runs.some((run) => ACTIVE_STATUSES.has(run.status));
      runsStatusText.textContent = hasActive ? "Автообновление каждые 3 с" : "Ожидание";

      const selectButtons = runsTableRoot.querySelectorAll("[data-action='select-run']");
      selectButtons.forEach((button) => {
        button.addEventListener("click", () => {
          selectedRunId = button.getAttribute("data-run-id");
          renderRunsTable();
          renderRunsTimeline(true);
        });
      });

      const cancelButtons = runsTableRoot.querySelectorAll("[data-action='cancel-run']");
      cancelButtons.forEach((button) => {
        button.addEventListener("click", async () => {
          const runId = button.getAttribute("data-run-id");
          if (!runId) {
            return;
          }

          button.disabled = true;
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
            button.disabled = false;
          }
        });
      });
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

      const prevPageBtn = subdomainsTableRoot.querySelector("[data-action='subdomains-prev-page']");
      if (prevPageBtn) {
        prevPageBtn.addEventListener("click", () => {
          const targetPage = Math.max(1, (Number(subdomainsPagination.page) || 1) - 1);
          void refreshSubdomains(true, { page: targetPage });
        });
      }

      const nextPageBtn = subdomainsTableRoot.querySelector("[data-action='subdomains-next-page']");
      if (nextPageBtn) {
        nextPageBtn.addEventListener("click", () => {
          const totalPages = Math.max(1, Number(subdomainsPagination.totalPages) || 1);
          const targetPage = Math.min(totalPages, (Number(subdomainsPagination.page) || 1) + 1);
          void refreshSubdomains(true, { page: targetPage });
        });
      }

      const pageSizeSelect = subdomainsTableRoot.querySelector("[data-action='subdomains-page-size']");
      if (pageSizeSelect) {
        pageSizeSelect.addEventListener("change", () => {
          const nextLimit = normalizeSubdomainsPageSize(pageSizeSelect.value);
          if (nextLimit === normalizeSubdomainsPageSize(subdomainsPagination.limit)) {
            return;
          }
          void refreshSubdomains(true, { page: 1, limit: nextLimit });
        });
      }

      const selectAllToggle = subdomainsTableRoot.querySelector("[data-action='subdomains-select-all']");
      if (selectAllToggle) {
        selectAllToggle.addEventListener("change", () => {
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
        });
      }

      const rowSelectToggles = subdomainsTableRoot.querySelectorAll("[data-action='toggle-subdomain-select']");
      rowSelectToggles.forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
          const id = checkbox.getAttribute("data-subdomain-id");
          if (!id) {
            return;
          }
          if (checkbox.checked) {
            selectedSubdomainIds.add(String(id));
          } else {
            selectedSubdomainIds.delete(String(id));
          }
          renderSubdomains();
        });
      });

      const editButtons = subdomainsTableRoot.querySelectorAll("[data-action='edit-subdomain']");
      editButtons.forEach((button) => {
        button.addEventListener("click", async () => {
          const subdomainId = button.getAttribute("data-subdomain-id");
          const currentHost = button.getAttribute("data-host") || "";
          if (!subdomainId) {
            return;
          }

          const nextHost = window.prompt("Изменить хост поддомена", currentHost);
          if (nextHost === null) {
            return;
          }

          button.disabled = true;
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
            button.disabled = false;
          }
        });
      });

      const deleteButtons = subdomainsTableRoot.querySelectorAll("[data-action='delete-subdomain']");
      deleteButtons.forEach((button) => {
        button.addEventListener("click", async () => {
          const subdomainId = button.getAttribute("data-subdomain-id");
          if (!subdomainId) {
            return;
          }

          const confirmed = window.confirm("Удалить этот поддомен?");
          if (!confirmed) {
            return;
          }

          button.disabled = true;
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
            button.disabled = false;
          }
        });
      });
    }

    function renderVtDeep() {
      vtDeepTableRoot.innerHTML = buildVtDeepTable(vtDeepData);
      if (vtDeepData && Array.isArray(vtDeepData.warnings) && vtDeepData.warnings.length) {
        setVtDeepMessage(`Предупреждения: ${vtDeepData.warnings.join("; ")}`, "error");
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
        renderVtDeep();
      } catch {
        // ignore background vt deep refresh errors
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
        if (runs.some((run) => run.taskKind === "WHOIS" && run.status === "SUCCESS")) {
          await refreshWhoisInfo();
        }
        if (runs.some((run) => run.taskKind === "VT_DEEP" && run.status === "SUCCESS")) {
          await refreshVtDeepInfo();
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
      runPassiveCoreBtn.disabled = disabled;
      runPassiveAllBtn.disabled = disabled;
      runPassiveProviderSelect.disabled = disabled || !passiveSources.length;
      runPassiveProviderBtn.disabled = disabled || !passiveSources.length;
      runWhoisBtn.disabled = disabled;
      runResolveFastBtn.disabled = disabled;
      runResolveExtendedBtn.disabled = disabled;
      exportDomainIpCsvBtn.disabled = disabled;
      deleteProjectBtn.disabled = disabled;
      projectDomainInput.disabled = disabled;
      projectDomainSubmit.disabled = disabled;
      vtDeepLoadBtn.disabled = disabled;
      resolveSelectedBtn.disabled = disabled || selectedSubdomainIds.size === 0;
      deleteSelectedBtn.disabled = disabled || selectedSubdomainIds.size === 0;
      exportSelectedCsvBtn.disabled = disabled || selectedSubdomainIds.size === 0;
    }

    async function queueAction(endpoint, successMessage, body) {
      setActionButtonsDisabled(true);
      setActionMessage("", "");

      try {
        await api(endpoint, { method: "POST", body });
        setActionMessage(successMessage, "success");
        await refreshRuns();
      } catch (error) {
        setActionMessage(friendlyError(error, "Не удалось выполнить действие"), "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    }

    runPassiveCoreBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/scan`,
        "Пассивный скан поставлен в очередь (base)",
        { scope: "core" },
      );
    });

    runPassiveAllBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/scan`,
        "Пассивный скан поставлен в очередь (all)",
        { scope: "all" },
      );
    });

    runPassiveProviderBtn.addEventListener("click", () => {
      const selectedSource = String(runPassiveProviderSelect.value || "").trim();
      if (!selectedSource) {
        setActionMessage("Сначала выберите провайдера", "error");
        return;
      }

      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/scan`,
        `Пассивный скан поставлен в очередь (провайдер: ${selectedSource})`,
        { scope: `provider:${selectedSource}` },
      );
    });

    runWhoisBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/whois-task`,
        "Задача WHOIS поставлена в очередь",
        {},
      );
    });

    tabSubdomainsBtn.addEventListener("click", () => {
      activeDataTab = "subdomains";
      renderDataTab();
    });

    tabVtDeepBtn.addEventListener("click", () => {
      activeDataTab = "vtdeep";
      renderDataTab();
      if (!vtDeepData) {
        void refreshVtDeepInfo();
      }
    });

    vtDeepLoadBtn.addEventListener("click", () => {
      void queueAction(
        `/api/projects/${encodeURIComponent(projectId)}/vt-deep-task`,
        "Задача VT Deep поставлена в очередь",
        {},
      );
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
        const fileName = fileNameMatch ? fileNameMatch[1] : `${project.domain}-domain-ip.csv`;
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
        const fileName = fileNameMatch ? fileNameMatch[1] : `${project.domain}-selected-domain-ip.csv`;
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
    renderVtDeep();
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
        (provider) => `
          <tr class="provider-row" data-provider="${escapeHtml(provider.provider)}">
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
            <td>${provider.hasToken ? "Да" : "Нет"}</td>
            <td>
              <input class="text-input provider-token" type="text" placeholder="Новый токен (необязательно)" />
            </td>
            <td>
              <div class="row wrap" style="margin-top:0">
                <button class="btn btn-primary provider-save" type="button">Сохранить</button>
                <button class="btn btn-ghost provider-clear" type="button">Очистить токен</button>
                <button class="btn btn-ghost provider-check-limit" type="button">Проверить лимит</button>
              </div>
              <div class="hint">Обновлено: ${escapeHtml(formatDate(provider.updatedAt))}</div>
              <div class="hint provider-row-message"></div>
            </td>
          </tr>
        `,
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
      const saveButton = row.querySelector(".provider-save");
      const clearButton = row.querySelector(".provider-clear");
      const checkLimitButton = row.querySelector(".provider-check-limit");
      const rowMessage = row.querySelector(".provider-row-message");

      function setRowMessage(message, kind) {
        rowMessage.textContent = message || "";
        if (!message) {
          rowMessage.style.color = "";
          return;
        }

        rowMessage.style.color = kind === "error" ? "#8a1919" : "#115e59";
      }

      async function save(clearToken) {
        saveButton.disabled = true;
        clearButton.disabled = true;
        checkLimitButton.disabled = true;
        setRowMessage("", "");

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
          saveButton.disabled = false;
          clearButton.disabled = false;
          checkLimitButton.disabled = false;
        }
      }

      saveButton.addEventListener("click", () => {
        void save(false);
      });

      clearButton.addEventListener("click", () => {
        void save(true);
      });

      checkLimitButton.addEventListener("click", async () => {
        saveButton.disabled = true;
        clearButton.disabled = true;
        checkLimitButton.disabled = true;
        setRowMessage("Проверка...", "success");

        try {
          const payload = await api("/api/settings/providers/check-limit", {
            method: "POST",
            body: { provider },
          });
          const result = payload && payload.result ? payload.result : null;
          const limit =
            result && Object.prototype.hasOwnProperty.call(result, "limit") && result.limit !== null
              ? `лимит=${result.limit}`
              : "лимит=?";
          const remaining =
            result && Object.prototype.hasOwnProperty.call(result, "remaining") && result.remaining !== null
              ? `остаток=${result.remaining}`
              : "остаток=?";
          const summary = result && result.summary ? String(result.summary) : "Проверка завершена";
          setRowMessage(`${summary} (${limit}, ${remaining})`, "success");
        } catch (error) {
          setRowMessage(friendlyError(error, "Не удалось проверить лимит"), "error");
        } finally {
          saveButton.disabled = false;
          clearButton.disabled = false;
          checkLimitButton.disabled = false;
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
              <select class="text-input user-role" style="min-width:120px">
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
              <div class="row wrap" style="margin-top:0">
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

  applyUiMode(state.uiMode, { skipPersist: true });
  void renderRoute();
})();
