export const searchStyles = `.search-input {
  display: block;
  width: 100%;
  min-height: 36px;
  margin-bottom: 14px;
  padding: 8px 12px 8px 34px;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--border) 82%, var(--accent));
  border-radius: 999px;
  outline: none;
  color: var(--vscode-input-foreground);
  background:
    radial-gradient(circle at 17px 17px, transparent 0 4px, var(--muted) 4.5px 5.8px, transparent 6.2px),
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 42%),
    color-mix(in srgb, var(--vscode-input-background) 94%, var(--surface-strong));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 1px 4px color-mix(in srgb, #000 14%, transparent);
  font-size: 12px;
  line-height: 1.45;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}

.search-input::placeholder {
  color: color-mix(in srgb, var(--muted) 78%, transparent);
}

.search-input:hover {
  border-color: var(--accent-border);
  background:
    radial-gradient(circle at 17px 17px, transparent 0 4px, var(--accent) 4.5px 5.8px, transparent 6.2px),
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent 42%),
    color-mix(in srgb, var(--vscode-input-background) 96%, var(--surface-strong));
}

.search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim), inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent), 0 6px 18px color-mix(in srgb, #000 18%, transparent);
}

.search-input::-webkit-search-cancel-button {
  cursor: pointer;
}

.search-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
}

.search-row .search-input {
  min-width: 0;
  margin-bottom: 0;
}

.search-navigation {
  display: inline-grid;
  grid-template-columns: auto minmax(46px, auto) auto;
  align-items: center;
  gap: 4px;
}

.search-position {
  min-width: 58px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}

.search-nav-button {
  min-width: 30px;
  padding: 5px 8px;
}

@media (max-width: 420px) {
  .search-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .search-navigation {
    width: 100%;
    grid-template-columns: minmax(38px, 1fr) auto minmax(38px, 1fr);
  }

  .search-nav-button {
    width: 100%;
    min-height: 30px;
  }
}

.searchable-textarea {
  position: relative;
}

.searchable-textarea textarea {
  position: relative;
  z-index: 0;
  padding-right: 24px;
}

.active-search-highlight {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  min-width: 2px;
  min-height: 1em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 46%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 72%, transparent);
}

.search-markers {
  position: absolute;
  top: 8px;
  right: 4px;
  bottom: 8px;
  width: 8px;
  pointer-events: none;
}

.search-marker {
  position: absolute;
  right: 0;
  width: 8px;
  min-height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 78%, #fff);
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 22%, transparent), 0 0 6px var(--accent-dim);
}

.search-marker.active {
  width: 10px;
  right: -1px;
  min-height: 5px;
  background: var(--ok);
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 28%, transparent), 0 0 8px color-mix(in srgb, var(--ok) 45%, transparent);
}
`;

export const searchMarkup = `          <label for="patch-search-input">Search in AI JSON response</label>
          <div class="search-row">
            <input id="patch-search-input" class="search-input" type="search" spellcheck="false" placeholder="Type text to find in the JSON below." />
            <div class="search-navigation" aria-label="Search navigation">
              <button id="search-prev" class="ghost search-nav-button" type="button" title="Previous match" disabled>↑</button>
              <span id="search-position" class="search-position">0 / 0</span>
              <button id="search-next" class="ghost search-nav-button" type="button" title="Next match" disabled>↓</button>
            </div>
          </div>
          <label for="patch-input">AI patch payload</label>
          <div class="searchable-textarea">
            <textarea id="patch-input" spellcheck="false" placeholder='{ "operations": [] }'></textarea>
            <div id="patch-active-search-highlight" class="active-search-highlight hidden" aria-hidden="true"></div>
            <div id="patch-search-markers" class="search-markers" aria-hidden="true"></div>
          </div>`;

export const searchDomBindings = `  const patchSearchInput = document.getElementById("patch-search-input");
  const searchPrev = document.getElementById("search-prev");
  const searchNext = document.getElementById("search-next");
  const searchPosition = document.getElementById("search-position");
  const searchMarkers = document.getElementById("patch-search-markers");
  const activeSearchHighlight = document.getElementById("patch-active-search-highlight");
  let searchMatches = [];
  let activeSearchIndex = -1;`;

export const searchScript = `  function findSearchMatches(value, search) {
    if (!search) return [];

    const matches = [];
    let index = value.indexOf(search);
    while (index !== -1) {
      matches.push({ start: index, end: index + search.length });
      index = value.indexOf(search, index + search.length);
    }
    return matches;
  }

  function getMarkerTop(match) {
    if (patchInput.value.length === 0) return 0;
    const maxTop = Math.max(0, searchMarkers.clientHeight - 5);
    return Math.round((match.start / patchInput.value.length) * maxTop);
  }

  function renderSearchMarkers() {
    searchMarkers.innerHTML = "";
    searchMatches.forEach((match, index) => {
      const marker = document.createElement("span");
      marker.className = "search-marker" + (index === activeSearchIndex ? " active" : "");
      marker.style.top = getMarkerTop(match) + "px";
      searchMarkers.append(marker);
    });
  }

  function createTextareaMirror(match) {
    const styles = window.getComputedStyle(patchInput);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.left = "-9999px";
    mirror.style.top = "0";
    mirror.style.boxSizing = styles.boxSizing;
    mirror.style.width = patchInput.clientWidth + "px";
    mirror.style.padding = styles.padding;
    mirror.style.border = styles.border;
    mirror.style.font = styles.font;
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.wordSpacing = styles.wordSpacing;
    mirror.style.lineHeight = styles.lineHeight;
    mirror.style.textAlign = styles.textAlign;
    mirror.style.textIndent = styles.textIndent;
    mirror.style.textTransform = styles.textTransform;
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.tabSize = styles.tabSize;

    mirror.textContent = patchInput.value.slice(0, match.start);
    marker.textContent = patchInput.value.slice(match.start, match.end) || " ";
    mirror.append(marker);
    document.body.append(mirror);

    return { mirror, marker };
  }

  function syncActiveSearchHighlightScroll() {
    renderActiveSearchHighlight(activeSearchIndex === -1 ? null : searchMatches[activeSearchIndex]);
  }

  function renderActiveSearchHighlight(match) {
    activeSearchHighlight.classList.toggle("hidden", !match);
    if (!match) return;

    const { mirror, marker } = createTextareaMirror(match);
    const left = marker.offsetLeft - patchInput.scrollLeft;
    const top = marker.offsetTop - patchInput.scrollTop;
    const width = Math.max(2, marker.offsetWidth);
    const height = Math.max(1, marker.offsetHeight);
    const isVisible = top + height >= 0 && top <= patchInput.clientHeight;

    activeSearchHighlight.classList.toggle("hidden", !isVisible);
    activeSearchHighlight.style.left = left + "px";
    activeSearchHighlight.style.top = top + "px";
    activeSearchHighlight.style.width = width + "px";
    activeSearchHighlight.style.height = height + "px";
    mirror.remove();
  }

  function scrollPatchInputToMatch(match) {
    const { mirror, marker } = createTextareaMirror(match);

    const desiredTop = marker.offsetTop - patchInput.clientHeight / 2 + marker.offsetHeight;
    const maxTop = Math.max(0, patchInput.scrollHeight - patchInput.clientHeight);
    patchInput.scrollTop = Math.min(maxTop, Math.max(0, desiredTop));
    mirror.remove();
  }

  function updateSearchUi() {
    const previousStart = searchMatches[activeSearchIndex]?.start;
    searchMatches = findSearchMatches(patchInput.value, patchSearchInput.value);
    activeSearchIndex = previousStart === undefined
      ? -1
      : searchMatches.findIndex(match => match.start === previousStart);

    searchPrev.disabled = searchMatches.length === 0;
    searchNext.disabled = searchMatches.length === 0;
    searchPosition.textContent = activeSearchIndex === -1
      ? "0 / " + searchMatches.length
      : (activeSearchIndex + 1) + " / " + searchMatches.length;
    renderSearchMarkers();
    renderActiveSearchHighlight(activeSearchIndex === -1 ? null : searchMatches[activeSearchIndex]);
    updateStats();
  }

  function findStartingSearchIndex(direction) {
    if (activeSearchIndex !== -1) return activeSearchIndex;

    if (direction > 0) {
      const next = searchMatches.findIndex(match => match.start >= patchInput.selectionStart);
      return next === -1 ? searchMatches.length - 1 : next - 1;
    }

    for (let index = searchMatches.length - 1; index >= 0; index -= 1) {
      if (searchMatches[index].end <= patchInput.selectionStart) return index;
    }
    return 0;
  }

  function moveSearch(direction, options = {}) {
    updateSearchUi();
    if (searchMatches.length === 0) return;

    const keepSearchFocus = options.keepSearchFocus === true;
    const startIndex = findStartingSearchIndex(direction);
    activeSearchIndex = (startIndex + direction + searchMatches.length) % searchMatches.length;
    const match = searchMatches[activeSearchIndex];
    if (!keepSearchFocus) patchInput.focus();
    patchInput.setSelectionRange(match.start, match.end);
    requestAnimationFrame(() => {
      scrollPatchInputToMatch(match);
      syncActiveSearchHighlightScroll();
      if (keepSearchFocus) patchSearchInput.focus();
    });
    searchPosition.textContent = (activeSearchIndex + 1) + " / " + searchMatches.length;
    renderSearchMarkers();
    renderActiveSearchHighlight(match);
  }`;

export const searchEventListeners = `  patchInput.addEventListener("input", () => { updateSearchUi(); persist(); });
  patchInput.addEventListener("scroll", () => {
    renderSearchMarkers();
    syncActiveSearchHighlightScroll();
  });
  patchSearchInput.addEventListener("input", () => { updateSearchUi(); persist(); });
  patchSearchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    moveSearch(event.shiftKey ? -1 : 1, { keepSearchFocus: true });
  });
  searchPrev.addEventListener("click", () => moveSearch(-1));
  searchNext.addEventListener("click", () => moveSearch(1));`;
