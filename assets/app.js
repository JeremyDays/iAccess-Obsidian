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

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

bootSearch();
bootImageLightbox();