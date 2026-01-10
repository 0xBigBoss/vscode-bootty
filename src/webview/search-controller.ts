/**
 * Search functionality for terminal webview
 * Handles search overlay UI, match finding, and navigation
 */

/** Terminal interface for search operations */
export interface SearchableTerminal {
	rows: number;
	buffer?: {
		active?: {
			length: number;
			getLine(
				y: number,
			): { translateToString(trimRight: boolean): string } | undefined;
		};
	};
	getScrollbackLength?(): number;
	scrollToLine?(line: number): void;
	select?(col: number, row: number, length: number): void;
	clearSelection?(): void;
	focus?(): void;
}

/** Search match location */
interface SearchMatch {
	row: number;
	startCol: number;
	endCol: number;
}

/** Search controller manages search overlay and match navigation */
export interface SearchController {
	show(): void;
	hide(): void;
	destroy(): void;
}

/**
 * Create search overlay DOM element
 * Uses class selectors instead of IDs to support multiple instances
 */
function createSearchOverlay(): HTMLElement {
	const overlay = document.createElement("div");
	overlay.className = "search-overlay";
	overlay.innerHTML = `
    <div class="search-container">
      <input type="text" class="search-input" placeholder="Search..." />
      <span class="search-results-count"></span>
      <button class="search-prev" title="Previous (Shift+Enter)">▲</button>
      <button class="search-next" title="Next (Enter)">▼</button>
      <button class="search-close" title="Close (Escape)">✕</button>
    </div>
  `;
	overlay.style.display = "none";
	return overlay;
}

/**
 * Extract all terminal lines for searching
 */
function getTerminalLines(term: SearchableTerminal): string[] {
	const lines: string[] = [];
	const buffer = term.buffer;
	if (!buffer?.active) return lines;

	const scrollbackLength = buffer.active.length || 0;
	for (let y = 0; y < scrollbackLength; y++) {
		const line = buffer.active.getLine(y);
		if (line) {
			lines.push(line.translateToString(true));
		}
	}
	return lines;
}

/**
 * Create a search controller for the terminal
 * @param term - Terminal instance with search capabilities
 * @returns SearchController instance
 */
export function createSearchController(
	term: SearchableTerminal,
): SearchController {
	// Create and append overlay
	const searchOverlay = createSearchOverlay();
	document.body.appendChild(searchOverlay);

	// Get DOM elements within this overlay (not global getElementById)
	const searchInput = searchOverlay.querySelector(
		".search-input",
	) as HTMLInputElement;
	const searchResultsCount = searchOverlay.querySelector(
		".search-results-count",
	) as HTMLElement;
	const searchPrevBtn = searchOverlay.querySelector(
		".search-prev",
	) as HTMLElement;
	const searchNextBtn = searchOverlay.querySelector(
		".search-next",
	) as HTMLElement;
	const searchCloseBtn = searchOverlay.querySelector(
		".search-close",
	) as HTMLElement;

	// Search state
	let searchMatches: SearchMatch[] = [];
	let currentMatchIndex = -1;

	// Update search UI with results count
	function updateSearchUI(): void {
		if (searchMatches.length === 0) {
			searchResultsCount.textContent = searchInput.value ? "No results" : "";
		} else {
			searchResultsCount.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
		}
	}

	// Highlight the current match by selecting it
	function highlightCurrentMatch(): void {
		if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length)
			return;

		const match = searchMatches[currentMatchIndex];
		const viewportRows = term.rows;

		// Get scrollback length (excluding visible rows)
		const scrollbackLength =
			term.getScrollbackLength?.() ??
			(term.buffer?.active?.length || 0) - viewportRows;

		// Calculate scroll position to center the match in viewport
		const targetViewportY = Math.max(
			0,
			Math.min(
				scrollbackLength,
				scrollbackLength - match.row + Math.floor(viewportRows / 2),
			),
		);

		term.scrollToLine?.(targetViewportY);

		// Convert absolute buffer row to viewport-relative row
		const viewportRelativeRow = match.row - scrollbackLength + targetViewportY;

		// Only select if the row is within viewport bounds
		if (viewportRelativeRow >= 0 && viewportRelativeRow < viewportRows) {
			term.select?.(
				match.startCol,
				viewportRelativeRow,
				match.endCol - match.startCol + 1,
			);
		}

		updateSearchUI();
	}

	// Perform search and find all matches
	function performSearch(query: string): void {
		searchMatches = [];
		currentMatchIndex = -1;

		if (!query) {
			updateSearchUI();
			term.clearSelection?.();
			return;
		}

		const lines = getTerminalLines(term);
		const lowerQuery = query.toLowerCase();

		for (let row = 0; row < lines.length; row++) {
			const line = lines[row].toLowerCase();
			let col = 0;
			while ((col = line.indexOf(lowerQuery, col)) !== -1) {
				searchMatches.push({
					row,
					startCol: col,
					endCol: col + query.length - 1,
				});
				col += 1; // Move past this match to find overlapping matches
			}
		}

		updateSearchUI();

		// Auto-select first match
		if (searchMatches.length > 0) {
			currentMatchIndex = 0;
			highlightCurrentMatch();
		} else {
			term.clearSelection?.();
		}
	}

	// Navigate to next match
	function goToNextMatch(): void {
		if (searchMatches.length === 0) return;
		currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
		highlightCurrentMatch();
	}

	// Navigate to previous match
	function goToPrevMatch(): void {
		if (searchMatches.length === 0) return;
		currentMatchIndex =
			(currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
		highlightCurrentMatch();
	}

	// Show search overlay
	function show(): void {
		searchOverlay.style.display = "block";
		searchInput.focus();
		searchInput.select();
	}

	// Hide search overlay
	function hide(): void {
		searchOverlay.style.display = "none";
		searchInput.value = "";
		searchMatches = [];
		currentMatchIndex = -1;
		searchResultsCount.textContent = "";
		term.clearSelection?.();
		term.focus?.();
	}

	// Event handlers
	const handleInput = () => performSearch(searchInput.value);

	const handleKeydown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) {
				goToPrevMatch();
			} else {
				goToNextMatch();
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			hide();
		}
	};

	// Attach event listeners
	searchInput.addEventListener("input", handleInput);
	searchInput.addEventListener("keydown", handleKeydown);
	searchPrevBtn.addEventListener("click", goToPrevMatch);
	searchNextBtn.addEventListener("click", goToNextMatch);
	searchCloseBtn.addEventListener("click", hide);

	// Cleanup function
	function destroy(): void {
		searchInput.removeEventListener("input", handleInput);
		searchInput.removeEventListener("keydown", handleKeydown);
		searchPrevBtn.removeEventListener("click", goToPrevMatch);
		searchNextBtn.removeEventListener("click", goToNextMatch);
		searchCloseBtn.removeEventListener("click", hide);
		searchOverlay.remove();
	}

	return { show, hide, destroy };
}
