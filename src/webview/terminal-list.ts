/**
 * Terminal List Component for the panel webview.
 * Displays a vertical list of terminals on the right side with split group support.
 */

import type { TerminalGroup } from "../types/messages";
import type { TerminalId } from "../types/terminal";

/** Terminal list item data */
export interface TerminalListItem {
	id: TerminalId;
	title: string;
	icon?: string; // Codicon name
	color?: string; // Color from palette
	groupId?: string; // For split terminals (undefined = standalone)
}

/** Terminal list state */
export interface TerminalListState {
	items: TerminalListItem[];
	groups: TerminalGroup[];
	listWidth: number;
	selectedTerminalId: TerminalId | null;
	focusedTerminalId: TerminalId | null;
}

/** Events emitted by the terminal list */
export interface TerminalListEvents {
	onSelect: (id: TerminalId) => void;
	onClose: (id: TerminalId) => void;
	onSplit: (id: TerminalId) => void;
	onContextMenu: (id: TerminalId, x: number, y: number) => void;
	onReorder: (ids: TerminalId[]) => void;
	onGroupReorder: (groupId: string, terminalIds: TerminalId[]) => void;
	onWidthChange: (width: number) => void;
}

/** Tree connector characters for split groups */
const TREE_CONNECTORS = {
	first: "┌",
	middle: "├",
	last: "└",
};

/** Default list width in pixels */
const DEFAULT_LIST_WIDTH = 180;
const MIN_LIST_WIDTH = 50;

/**
 * Terminal List controller.
 * Manages the terminal list UI within the panel webview.
 */
export class TerminalList {
	private container: HTMLElement;
	private listElement: HTMLElement;
	private divider: HTMLElement;
	private state: TerminalListState;
	private events: TerminalListEvents;
	private isDraggingDivider = false;

	constructor(
		container: HTMLElement,
		events: TerminalListEvents,
		initialWidth = DEFAULT_LIST_WIDTH,
	) {
		this.container = container;
		this.events = events;
		this.state = {
			items: [],
			groups: [],
			listWidth: initialWidth,
			selectedTerminalId: null,
			focusedTerminalId: null,
		};

		// Create list container
		this.listElement = document.createElement("div");
		this.listElement.className = "terminal-list";
		this.listElement.style.width = `${initialWidth}px`;

		// Create resizable divider
		this.divider = document.createElement("div");
		this.divider.className = "terminal-list-divider";
		this.setupDividerDrag();

		// Add elements to container
		container.appendChild(this.divider);
		container.appendChild(this.listElement);

		// Initial render
		this.render();
	}

	/** Update list width */
	setWidth(width: number): void {
		const maxWidth = this.container.clientWidth * 0.5;
		const clampedWidth = Math.max(MIN_LIST_WIDTH, Math.min(width, maxWidth));
		this.state.listWidth = clampedWidth;
		this.listElement.style.width = `${clampedWidth}px`;
	}

	/** Get current list width */
	getWidth(): number {
		return this.state.listWidth;
	}

	/** Add a terminal to the list */
	addTerminal(item: TerminalListItem, insertAfter?: TerminalId): void {
		// Check if terminal already exists
		const existingIndex = this.state.items.findIndex((i) => i.id === item.id);
		if (existingIndex >= 0) {
			// Update existing
			this.state.items[existingIndex] = item;
		} else if (insertAfter) {
			// Insert after the specified terminal
			const afterIndex = this.state.items.findIndex(
				(i) => i.id === insertAfter,
			);
			if (afterIndex >= 0) {
				this.state.items.splice(afterIndex + 1, 0, item);
			} else {
				// Fallback to append if insertAfter not found
				this.state.items.push(item);
			}
		} else {
			// Add new at the end
			this.state.items.push(item);
		}
		this.render();
	}

	/** Remove a terminal from the list */
	removeTerminal(id: TerminalId): void {
		this.state.items = this.state.items.filter((item) => item.id !== id);
		if (this.state.selectedTerminalId === id) {
			this.state.selectedTerminalId = null;
		}
		if (this.state.focusedTerminalId === id) {
			this.state.focusedTerminalId = null;
		}
		this.render();
	}

	/** Rename a terminal */
	renameTerminal(id: TerminalId, title: string): void {
		const item = this.state.items.find((i) => i.id === id);
		if (item) {
			item.title = title;
			this.render();
		}
	}

	/** Set the selected terminal */
	setSelected(id: TerminalId | null): void {
		if (this.state.selectedTerminalId !== id) {
			this.state.selectedTerminalId = id;
			// Focus is cleared when selection changes (per spec)
			this.state.focusedTerminalId = null;
			this.render();
		}
	}

	/** Set the focused terminal */
	setFocused(id: TerminalId | null): void {
		this.state.focusedTerminalId = id;
		this.render();
	}

	/** Update terminal color */
	setTerminalColor(id: TerminalId, color: string): void {
		const item = this.state.items.find((i) => i.id === id);
		if (item) {
			item.color = color;
			this.render();
		}
	}

	/** Update terminal icon */
	setTerminalIcon(id: TerminalId, icon: string): void {
		const item = this.state.items.find((i) => i.id === id);
		if (item) {
			item.icon = icon;
			this.render();
		}
	}

	/** Set terminal group membership */
	setTerminalGroup(id: TerminalId, groupId: string | undefined): void {
		const item = this.state.items.find((i) => i.id === id);
		if (item) {
			item.groupId = groupId;
			this.render();
		}
	}

	/** Add or update a group */
	updateGroup(group: TerminalGroup): void {
		const existingIndex = this.state.groups.findIndex((g) => g.id === group.id);
		if (existingIndex >= 0) {
			this.state.groups[existingIndex] = group;
		} else {
			this.state.groups.push(group);
		}
		// Update terminals with their group membership
		for (const terminalId of group.terminals) {
			const item = this.state.items.find((i) => i.id === terminalId);
			if (item) {
				item.groupId = group.id;
			}
		}
		this.render();
	}

	/** Remove a group */
	removeGroup(groupId: string): void {
		this.state.groups = this.state.groups.filter((g) => g.id !== groupId);
		// Clear group membership from terminals
		for (const item of this.state.items) {
			if (item.groupId === groupId) {
				item.groupId = undefined;
			}
		}
		this.render();
	}

	/** Get all terminal IDs in current order */
	getTerminalIds(): TerminalId[] {
		return this.state.items.map((item) => item.id);
	}

	/** Reorder items to match the given order from extension */
	reorderItems(terminalIds: TerminalId[]): void {
		const itemMap = new Map(this.state.items.map((item) => [item.id, item]));
		const newItems: TerminalListItem[] = [];
		for (const id of terminalIds) {
			const item = itemMap.get(id);
			if (item) {
				newItems.push(item);
			}
		}
		this.state.items = newItems;
		this.render();
	}

	/** Setup divider drag handling */
	private setupDividerDrag(): void {
		let startX = 0;
		let startWidth = 0;

		const onMouseMove = (e: MouseEvent) => {
			if (!this.isDraggingDivider) return;
			const deltaX = startX - e.clientX;
			const newWidth = startWidth + deltaX;
			this.setWidth(newWidth);
		};

		const onMouseUp = () => {
			if (this.isDraggingDivider) {
				this.isDraggingDivider = false;
				document.body.style.cursor = "";
				this.events.onWidthChange(this.state.listWidth);
			}
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};

		this.divider.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.isDraggingDivider = true;
			startX = e.clientX;
			startWidth = this.state.listWidth;
			document.body.style.cursor = "ew-resize";
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		});
	}

	/** Get tree connector for a terminal in a group */
	private getTreeConnector(item: TerminalListItem): {
		prefix: string;
		isInGroup: boolean;
	} {
		if (!item.groupId) {
			return { prefix: "", isInGroup: false };
		}

		const group = this.state.groups.find((g) => g.id === item.groupId);
		if (!group) {
			return { prefix: "", isInGroup: false };
		}

		const index = group.terminals.indexOf(item.id);
		if (index === -1) {
			return { prefix: "", isInGroup: false };
		}

		if (index === 0) {
			return { prefix: TREE_CONNECTORS.first, isInGroup: true };
		}
		if (index === group.terminals.length - 1) {
			return { prefix: TREE_CONNECTORS.last, isInGroup: true };
		}
		return { prefix: TREE_CONNECTORS.middle, isInGroup: true };
	}

	/** Render the terminal list */
	private render(): void {
		this.listElement.innerHTML = "";

		// Group items by groupId, maintaining order
		const renderedItems = new Set<TerminalId>();

		for (const item of this.state.items) {
			if (renderedItems.has(item.id)) continue;

			if (item.groupId) {
				// Render entire group together
				const group = this.state.groups.find((g) => g.id === item.groupId);
				if (group) {
					for (const terminalId of group.terminals) {
						const groupItem = this.state.items.find((i) => i.id === terminalId);
						if (groupItem && !renderedItems.has(groupItem.id)) {
							this.renderItem(groupItem);
							renderedItems.add(groupItem.id);
						}
					}
				} else {
					// Group not found, render as standalone
					this.renderItem(item);
					renderedItems.add(item.id);
				}
			} else {
				// Standalone terminal
				this.renderItem(item);
				renderedItems.add(item.id);
			}
		}
	}

	/** Render a single terminal list item */
	private renderItem(item: TerminalListItem): void {
		const { prefix } = this.getTreeConnector(item);
		const isSelected = this.state.selectedTerminalId === item.id;
		const isFocused = this.state.focusedTerminalId === item.id;

		// Check if this terminal belongs to the selected group
		let isInSelectedGroup = false;
		if (item.groupId && this.state.selectedTerminalId) {
			const selectedItem = this.state.items.find(
				(i) => i.id === this.state.selectedTerminalId,
			);
			isInSelectedGroup = selectedItem?.groupId === item.groupId;
		}

		const itemEl = document.createElement("div");
		itemEl.className = "terminal-list-item";
		if (isSelected || isInSelectedGroup) {
			itemEl.classList.add("selected");
		}
		if (isFocused) {
			itemEl.classList.add("focused");
		}
		itemEl.dataset.terminalId = item.id;

		// Tree connector prefix
		if (prefix) {
			const prefixEl = document.createElement("span");
			prefixEl.className = "tree-connector";
			prefixEl.textContent = `${prefix} `;
			itemEl.appendChild(prefixEl);
		}

		// Color indicator (if set)
		if (item.color) {
			const colorDot = document.createElement("span");
			colorDot.className = "color-indicator";
			colorDot.style.backgroundColor = item.color;
			itemEl.appendChild(colorDot);
		}

		// Icon
		const iconEl = document.createElement("span");
		iconEl.className = `codicon codicon-${item.icon || "terminal"}`;
		itemEl.appendChild(iconEl);

		// Title
		const titleEl = document.createElement("span");
		titleEl.className = "terminal-title";
		titleEl.textContent = item.title;
		itemEl.appendChild(titleEl);

		// Hover buttons container
		const hoverButtons = document.createElement("div");
		hoverButtons.className = "hover-buttons";

		// Split button
		const splitBtn = document.createElement("button");
		splitBtn.className = "hover-btn codicon codicon-split-horizontal";
		splitBtn.title = "Split Terminal";
		splitBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.events.onSplit(item.id);
		});
		hoverButtons.appendChild(splitBtn);

		// Close button
		const closeBtn = document.createElement("button");
		closeBtn.className = "hover-btn codicon codicon-trash";
		closeBtn.title = "Kill Terminal";
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.events.onClose(item.id);
		});
		hoverButtons.appendChild(closeBtn);

		itemEl.appendChild(hoverButtons);

		// Click handler
		itemEl.addEventListener("click", () => {
			this.events.onSelect(item.id);
		});

		// Right-click context menu
		itemEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.events.onContextMenu(item.id, e.clientX, e.clientY);
		});

		// Drag-and-drop support for all terminals
		itemEl.draggable = true;

		itemEl.addEventListener("dragstart", (e) => {
			// Store both terminal ID and group ID for drop zone detection
			e.dataTransfer?.setData("text/plain", item.id);
			e.dataTransfer?.setData("application/x-group-id", item.groupId ?? "");
			itemEl.classList.add("dragging");
		});

		itemEl.addEventListener("dragend", () => {
			itemEl.classList.remove("dragging");
		});

		itemEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			itemEl.classList.add("drag-over");
		});

		itemEl.addEventListener("dragleave", () => {
			itemEl.classList.remove("drag-over");
		});

		itemEl.addEventListener("drop", (e) => {
			e.preventDefault();
			itemEl.classList.remove("drag-over");
			const sourceId = e.dataTransfer?.getData("text/plain") as TerminalId;
			const sourceGroupId = e.dataTransfer?.getData("application/x-group-id");
			if (sourceId && sourceId !== item.id) {
				this.handleReorder(
					sourceId,
					item.id,
					sourceGroupId || undefined,
					item.groupId,
				);
			}
		});

		this.listElement.appendChild(itemEl);
	}

	/** Handle reorder when an item is dropped on another */
	private handleReorder(
		sourceId: TerminalId,
		targetId: TerminalId,
		sourceGroupId?: string,
		targetGroupId?: string,
	): void {
		const sourceItem = this.state.items.find((i) => i.id === sourceId);
		const targetItem = this.state.items.find((i) => i.id === targetId);
		if (!sourceItem || !targetItem) return;

		// Case 1: Both in same group - reorder within group
		if (sourceGroupId && sourceGroupId === targetGroupId) {
			const group = this.state.groups.find((g) => g.id === sourceGroupId);
			if (group) {
				const sourceIdx = group.terminals.indexOf(sourceId);
				const targetIdx = group.terminals.indexOf(targetId);
				if (sourceIdx !== -1 && targetIdx !== -1) {
					group.terminals.splice(sourceIdx, 1);
					group.terminals.splice(targetIdx, 0, sourceId);
					// Also update items order to match group order
					this.reorderItemsToMatchGroups();
					// Notify extension of group order change
					this.events.onGroupReorder(sourceGroupId, [...group.terminals]);
					this.render();
					return; // Don't emit flat reorder for within-group changes
				}
			}
		}
		// Case 2: Source is grouped, target is different group or standalone - move entire group
		else if (sourceGroupId) {
			const group = this.state.groups.find((g) => g.id === sourceGroupId);
			if (group) {
				// Remove all group items from their current positions
				const groupItems = this.state.items.filter(
					(i) => i.groupId === sourceGroupId,
				);
				this.state.items = this.state.items.filter(
					(i) => i.groupId !== sourceGroupId,
				);

				// Find target position (after removing group items)
				const targetIndex = this.state.items.findIndex(
					(i) => i.id === targetId,
				);
				if (targetIndex !== -1) {
					// Insert entire group at target position
					this.state.items.splice(targetIndex, 0, ...groupItems);
				} else {
					// Target was in the removed group, append at end
					this.state.items.push(...groupItems);
				}
			}
		}
		// Case 3: Standalone terminals - simple reorder
		else {
			const sourceIndex = this.state.items.findIndex((i) => i.id === sourceId);
			const targetIndex = this.state.items.findIndex((i) => i.id === targetId);
			if (sourceIndex !== -1 && targetIndex !== -1) {
				const [removed] = this.state.items.splice(sourceIndex, 1);
				this.state.items.splice(targetIndex, 0, removed);
			}
		}

		// Re-render and notify
		this.render();
		this.events.onReorder(this.state.items.map((i) => i.id));
	}

	/** Reorder items array to match the order of terminals within groups */
	private reorderItemsToMatchGroups(): void {
		const newItems: TerminalListItem[] = [];
		const renderedIds = new Set<TerminalId>();

		for (const item of this.state.items) {
			if (renderedIds.has(item.id)) continue;

			if (item.groupId) {
				// Add all group members in group order
				const group = this.state.groups.find((g) => g.id === item.groupId);
				if (group) {
					for (const tid of group.terminals) {
						const groupItem = this.state.items.find((i) => i.id === tid);
						if (groupItem && !renderedIds.has(tid)) {
							newItems.push(groupItem);
							renderedIds.add(tid);
						}
					}
				}
			} else {
				newItems.push(item);
				renderedIds.add(item.id);
			}
		}

		this.state.items = newItems;
	}

	/** Destroy the terminal list */
	destroy(): void {
		this.listElement.remove();
		this.divider.remove();
	}
}
