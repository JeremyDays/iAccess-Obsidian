async function bootSearch() {
  const input = document.querySelector("#site-search");
  const results = document.querySelector("#search-results");
  if (!input || !results) return;
  const shell = input.closest(".search-shell");

  const rootPrefix = window.location.pathname.includes("/notes/") ? "../" : "";
  const notes = await fetch(rootPrefix + "api/index.json").then((response) => response.json()).catch(() => []);
  const haystack = notes.map((note) => ({
    ...note,
    aliases: normalizeAliases(note.frontmatter?.aliases || note.frontmatter?.alias || []),
    text: [note.title, ...normalizeAliases(note.frontmatter?.aliases || note.frontmatter?.alias || [])].join(" ").toLowerCase()
  }));

  const resultLinks = () => Array.from(results.querySelectorAll("a"));
  const focusResult = (index) => {
    const links = resultLinks();
    if (!links.length) return false;
    const next = ((index % links.length) + links.length) % links.length;
    links[next].focus();
    links[next].scrollIntoView({ block: "nearest" });
    return true;
  };
  const focusSearchInput = () => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    results.innerHTML = "";
    shell?.classList.remove("has-results");
    shell?.style.setProperty("--search-shift", "0px");
    if (!query) return;

    const matches = haystack.filter((note) => note.text.includes(query)).slice(0, 10);
    results.innerHTML = matches.length
      ? matches.map((note) => '<a href="' + rootPrefix + note.url + '"><strong>' + escapeHtml(note.title) + '</strong>' + (note.aliases.length ? '<span>' + escapeHtml(note.aliases.join(", ")) + '</span>' : '') + '</a>').join("")
      : '<p class="muted">Keine Treffer.</p>';
    shell?.classList.add("has-results");
    updateSearchDropdown(shell, results);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && focusResult(0)) {
      event.preventDefault();
    } else if (event.key === "ArrowUp" && focusResult(-1)) {
      event.preventDefault();
    }
  });

  results.addEventListener("keydown", (event) => {
    const links = resultLinks();
    const index = links.indexOf(document.activeElement);
    if (index === -1) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusResult(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusResult(index - 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusSearchInput();
    } else if (event.key === "Enter") {
      event.preventDefault();
      window.location.href = links[index].href;
    }
  });

  window.addEventListener("resize", () => updateSearchDropdown(shell, results));
}

function updateSearchDropdown(shell, results) {
  if (!shell || !results || !shell.classList.contains("has-results")) return;
  shell.style.setProperty("--search-shift", "0px");
  const rect = shell.getBoundingClientRect();
  const gap = 7;
  const below = Math.max(0, window.innerHeight - rect.bottom - gap);
  const wanted = Math.min(results.scrollHeight, window.innerHeight * 0.9);
  const maxShift = Math.max(0, rect.top - gap);
  const shift = Math.min(Math.max(0, wanted - below), maxShift);
  shell.style.setProperty("--search-shift", shift ? "-" + shift + "px" : "0px");
  shell.style.setProperty("--search-space-below", (below + shift) + "px");
}

function normalizeAliases(value) {
  const aliases = Array.isArray(value) ? value : [value];
  return aliases.map((item) => String(item || "").trim()).filter(Boolean);
}

function bootImageLightbox() {
  const images = document.querySelectorAll(".content img");
  if (!images.length) return;

  const lightbox = document.createElement("div");
  lightbox.className = "image-lightbox";
  lightbox.setAttribute("role", "dialog");
  lightbox.setAttribute("aria-modal", "true");
  lightbox.innerHTML = '<img alt="">';
  document.body.appendChild(lightbox);

  const lightboxImage = lightbox.querySelector("img");
  let zoom = 1;
  let maxZoom = 1;
  const applyZoom = () => {
    lightboxImage.style.width = lightboxImage.dataset.fitWidth ? (Number(lightboxImage.dataset.fitWidth) * zoom) + "px" : "";
    lightboxImage.style.height = "auto";
  };
  const close = () => {
    lightbox.classList.remove("is-open");
    lightbox.classList.remove("is-zoomable");
    lightboxImage.removeAttribute("src");
    lightboxImage.removeAttribute("style");
    lightboxImage.removeAttribute("data-fit-width");
  };

  images.forEach((image) => {
    image.addEventListener("click", () => {
      const isMap = document.body.classList.contains("note-karte-von-barovia") && image.classList.contains("vault-embed");
      zoom = 1;
      maxZoom = isMap ? 2 : 1;
      lightboxImage.src = image.currentSrc || image.src;
      lightboxImage.alt = image.alt || "";
      lightbox.classList.toggle("is-zoomable", isMap);
      lightbox.classList.add("is-open");
      lightboxImage.onload = () => {
        if (!isMap) return;
        const fitWidth = Math.min(lightboxImage.naturalWidth, window.innerWidth - 48);
        lightboxImage.dataset.fitWidth = String(fitWidth);
        applyZoom();
      };
    });
  });

  lightbox.addEventListener("wheel", (event) => {
    if (!lightbox.classList.contains("is-zoomable")) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    zoom = Math.min(maxZoom, Math.max(0.3, zoom + direction * 0.15));
    applyZoom();
  }, { passive: false });

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });
  lightboxImage.addEventListener("click", () => {
    if (!lightbox.classList.contains("is-zoomable")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function bootFolderTree() {
  const tree = document.querySelector(".category-tree");
  if (!tree) return;
  const storageKey = "iaccess-folder-tree-open";
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  } catch {
    stored = [];
  }
  const openIds = new Set(Array.isArray(stored) ? stored : []);
  const details = Array.from(tree.querySelectorAll("details[data-tree-id]"));
  details.forEach((item) => {
    if (openIds.has(item.dataset.treeId)) item.open = true;
    item.addEventListener("toggle", () => {
      const next = details.filter((entry) => entry.open).map((entry) => entry.dataset.treeId);
      localStorage.setItem(storageKey, JSON.stringify(next));
    });
  });

  const currentPath = decodeURIComponent(window.location.pathname).replace(/\/+$/, "");
  const active = Array.from(tree.querySelectorAll("a.tree-note")).find((link) => {
    const linkPath = decodeURIComponent(new URL(link.href, window.location.href).pathname).replace(/\/+$/, "");
    return linkPath === currentPath;
  });
  if (!active) return;
  active.classList.add("is-active");
  active.setAttribute("aria-current", "page");
  let parent = active.parentElement;
  while (parent && parent !== tree) {
    if (parent.matches?.("details[data-tree-id]")) parent.open = true;
    parent = parent.parentElement;
  }
  localStorage.setItem(storageKey, JSON.stringify(details.filter((entry) => entry.open).map((entry) => entry.dataset.treeId)));
  requestAnimationFrame(() => active.scrollIntoView({ block: "nearest" }));
}

function bootNotePreviews() {
  if (!document.querySelector("[data-preview-url]")) return;
  const preview = document.createElement("aside");
  preview.className = "note-preview";
  preview.setAttribute("aria-label", "Notizvorschau");
  preview.innerHTML = '<div class="note-preview-bar"><strong>Vorschau</strong><a href="#">Öffnen</a><button type="button" aria-label="Schließen">×</button></div><div class="note-preview-content"></div>';
  document.body.appendChild(preview);
  const title = preview.querySelector("strong");
  const openLink = preview.querySelector("a");
  const closeButton = preview.querySelector("button");
  const content = preview.querySelector(".note-preview-content");
  const cache = new Map();
  let closeTimer = 0;
  let requestId = 0;

  const cancelClose = () => window.clearTimeout(closeTimer);
  const close = () => {
    cancelClose();
    preview.classList.remove("is-open");
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(close, 260);
  };
  const open = async (link) => {
    cancelClose();
    const url = new URL(link.dataset.previewUrl, window.location.href).href;
    title.textContent = link.textContent.trim() || "Vorschau";
    openLink.href = url;
    preview.classList.add("is-open");
    const id = ++requestId;
    if (cache.has(url)) {
      content.innerHTML = cache.get(url);
      return;
    }
    content.innerHTML = '<p class="muted">Vorschau wird geladen…</p>';
    const html = await fetch(url).then((response) => response.ok ? response.text() : "").catch(() => "");
    if (id !== requestId) return;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const article = parsed.querySelector(".note-detail");
    const markup = article ? article.outerHTML : '<p class="muted">Keine Vorschau verfügbar.</p>';
    cache.set(url, markup);
    content.innerHTML = markup;
    content.scrollTop = 0;
  };

  document.addEventListener("pointerover", (event) => {
    const link = event.target.closest?.("[data-preview-url]");
    if (!link || link.contains(event.relatedTarget)) return;
    open(link);
  });
  document.addEventListener("pointerout", (event) => {
    const link = event.target.closest?.("[data-preview-url]");
    if (!link || link.contains(event.relatedTarget)) return;
    scheduleClose();
  });
  preview.addEventListener("pointerenter", cancelClose);
  preview.addEventListener("pointerleave", scheduleClose);
  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function bootProjectMaps() {
  const dataElement = document.querySelector("#project-map-data");
  if (!dataElement || !window.L) return;
  let projects = [];
  try {
    projects = JSON.parse(dataElement.textContent || "[]");
  } catch {
    return;
  }
  const settings = {
    DE: { center: [51.1, 10.4], zoom: 6 },
    FR: { center: [46.6, 2.4], zoom: 6 },
    JP: { center: [36.2, 138.2], zoom: 5 }
  };
  const maps = new Map();
  document.querySelectorAll(".project-map[data-country]").forEach((element) => {
    const country = element.dataset.country;
    const setting = settings[country];
    const map = L.map(element, { scrollWheelZoom: true }).setView(setting.center, setting.zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    maps.set(country, { map, bounds: [] });
  });

  const markerFor = (project) => {
    if (!project.coordinates || !maps.has(project.country)) return;
    const target = maps.get(project.country);
    const icon = L.divIcon({
      className: "map-pin-shell",
      html: '<div class="map-pin ' + escapeHtml(project.status) + '"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 18],
      popupAnchor: [0, -17]
    });
    L.marker(project.coordinates, { icon }).addTo(target.map)
      .bindPopup('<a href="' + escapeHtml(project.url) + '">' + escapeHtml(project.title) + '</a><br>' + escapeHtml(project.location || ""));
    target.bounds.push(project.coordinates);
  };

  projects.filter((project) => project.coordinates).forEach(markerFor);
  const cacheKey = "iaccess-project-geocoding-v1";
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(cacheKey) || "{}");
  } catch {
    cache = {};
  }
  const missing = projects.filter((project) => !project.coordinates && project.location);
  const updateProgress = () => {
    for (const country of Object.keys(settings)) {
      const countryProjects = projects.filter((project) => project.country === country);
      const located = countryProjects.filter((project) => project.coordinates).length;
      const progress = document.querySelector('[data-map-progress="' + country + '"]');
      if (progress) progress.textContent = located + " von " + countryProjects.length + " Projekten verortet";
    }
  };
  const fitMaps = () => {
    for (const target of maps.values()) {
      if (target.bounds.length > 1) target.map.fitBounds(target.bounds, { padding: [24, 24], maxZoom: 11 });
    }
  };
  updateProgress();
  fitMaps();

  const geocode = async (project) => {
    const key = project.country + "|" + project.location.toLowerCase();
    if (Array.isArray(cache[key])) return cache[key];
    const url = "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(project.location) + "&count=1&language=de&format=json&countryCode=" + project.country;
    const result = await fetch(url).then((response) => response.ok ? response.json() : null).catch(() => null);
    const hit = result?.results?.[0];
    const coordinates = hit ? [hit.latitude, hit.longitude] : null;
    cache[key] = coordinates;
    localStorage.setItem(cacheKey, JSON.stringify(cache));
    return coordinates;
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const project = missing[cursor++];
      project.coordinates = await geocode(project);
      if (project.coordinates) markerFor(project);
      updateProgress();
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
  };
  Promise.all([worker(), worker(), worker()]).then(fitMaps);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

bootSearch();
bootImageLightbox();
bootFolderTree();
bootNotePreviews();
bootProjectMaps();