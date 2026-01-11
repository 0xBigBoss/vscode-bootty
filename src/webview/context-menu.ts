/**
 * Custom context menu component for the terminal list.
 * Uses CSS styling to match VS Code's look and feel.
 */

import type { TerminalGroup } from "../types/messages";
import type { TerminalId } from "../types/terminal";

/** Context menu item type */
export interface ContextMenuItem {
	label: string;
	shortcut?: string;
	icon?: string;
	disabled?: boolean;
	separator?: boolean;
	submenu?: ContextMenuItem[];
	action?: () => void;
}

/** Context menu events */
export interface ContextMenuEvents {
	onSplit: (id: TerminalId) => void;
	onUnsplit: (id: TerminalId) => void;
	onJoin: (id: TerminalId, targetGroupId: string) => void;
	onColorPicker: (id: TerminalId) => void; // Opens VS Code quick pick
	onIconPicker: (id: TerminalId) => void; // Opens VS Code quick pick
	onRename: (id: TerminalId) => void;
	onKill: (id: TerminalId) => void;
	// Multi-select events
	onGroupSelected: (ids: TerminalId[]) => void;
	onKillSelected: (ids: TerminalId[]) => void;
}

/**
 * Context Menu controller.
 * Displays a custom context menu at the specified position.
 */
/** Delay before hiding submenu (ms) - allows diagonal mouse movement */
const SUBMENU_HIDE_DELAY = 150;

export class ContextMenu {
	private element: HTMLElement | null = null;
	private submenuElement: HTMLElement | null = null;
	private submenuHideTimer: ReturnType<typeof setTimeout> | null = null;
	private events: ContextMenuEvents;
	private groups: TerminalGroup[] = [];

	constructor(events: ContextMenuEvents) {
		this.events = events;

		// Close menu on click outside
		document.addEventListener("click", this.handleOutsideClick.bind(this));
		document.addEventListener(
			"contextmenu",
			this.handleOutsideClick.bind(this),
		);
	}

	/** Update available groups for Join submenu */
	setGroups(groups: TerminalGroup[]): void {
		this.groups = groups;
	}

	/** Show context menu for a terminal */
	show(
		terminalId: TerminalId,
		x: number,
		y: number,
		isInGroup: boolean,
		groupId: string | undefined,
		groupNames: Map<string, string>,
	): void {
		this.hide();

		const items = this.buildMenuItems(
			terminalId,
			isInGroup,
			groupId,
			groupNames,
		);
		this.element = this.createMenuElement(items, x, y);
		document.body.appendChild(this.element);

		// Position adjustment to stay within viewport
		this.adjustPosition(this.element, x, y);
	}

	/** Show context menu for multiple selected terminals */
	showMultiSelect(terminalIds: TerminalId[], x: number, y: number): void {
		this.hide();

		const items = this.buildMultiSelectMenuItems(terminalIds);
		this.element = this.createMenuElement(items, x, y);
		document.body.appendChild(this.element);

		// Position adjustment to stay within viewport
		this.adjustPosition(this.element, x, y);
	}

	/** Hide the context menu */
	hide(): void {
		this.cancelSubmenuHideTimer();
		if (this.element) {
			this.element.remove();
			this.element = null;
		}
		if (this.submenuElement) {
			this.submenuElement.remove();
			this.submenuElement = null;
		}
	}

	/** Build menu items based on terminal state */
	private buildMenuItems(
		terminalId: TerminalId,
		isInGroup: boolean,
		_groupId: string | undefined,
		groupNames: Map<string, string>,
	): ContextMenuItem[] {
		const items: ContextMenuItem[] = [];

		// Split Terminal
		items.push({
			label: "Split Terminal",
			shortcut: "⌘\\",
			icon: "split-horizontal",
			action: () => this.events.onSplit(terminalId),
		});

		// Unsplit Terminal (only for grouped terminals)
		if (isInGroup) {
			items.push({
				label: "Unsplit Terminal",
				action: () => this.events.onUnsplit(terminalId),
			});
		}

		// Join Group (only for standalone terminals when groups exist)
		if (!isInGroup && this.groups.length > 0) {
			const joinSubmenu: ContextMenuItem[] = this.groups.map((group) => ({
				label: groupNames.get(group.id) || `Group ${group.id.slice(0, 8)}`,
				action: () => this.events.onJoin(terminalId, group.id),
			}));
			items.push({
				label: "Join Group",
				icon: "arrow-right",
				submenu: joinSubmenu,
			});
		}

		items.push({ separator: true, label: "" });

		// Change Color (opens VS Code quick pick)
		items.push({
			label: "Change Color...",
			icon: "symbol-color",
			action: () => this.events.onColorPicker(terminalId),
		});

		// Change Icon (opens VS Code quick pick)
		items.push({
			label: "Change Icon...",
			icon: "symbol-misc",
			action: () => this.events.onIconPicker(terminalId),
		});

		// Rename
		items.push({
			label: "Rename...",
			icon: "edit",
			action: () => this.events.onRename(terminalId),
		});

		items.push({ separator: true, label: "" });

		// Kill Terminal
		items.push({
			label: "Kill Terminal",
			shortcut: "⌘⌫",
			icon: "trash",
			action: () => this.events.onKill(terminalId),
		});

		return items;
	}

	/** Build menu items for multi-select context menu */
	private buildMultiSelectMenuItems(
		terminalIds: TerminalId[],
	): ContextMenuItem[] {
		const items: ContextMenuItem[] = [];
		const count = terminalIds.length;

		// Group Selected Terminals
		items.push({
			label: `Group ${count} Terminals`,
			icon: "combine",
			action: () => this.events.onGroupSelected(terminalIds),
		});

		items.push({ separator: true, label: "" });

		// Kill Selected Terminals
		items.push({
			label: `Kill ${count} Terminals`,
			icon: "trash",
			action: () => this.events.onKillSelected(terminalIds),
		});

		return items;
	}

	/** Create the menu DOM element */
	private createMenuElement(
		items: ContextMenuItem[],
		x: number,
		y: number,
	): HTMLElement {
		const menu = document.createElement("div");
		menu.className = "context-menu";
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;

		for (const item of items) {
			if (item.separator) {
				const sep = document.createElement("div");
				sep.className = "context-menu-separator";
				menu.appendChild(sep);
				continue;
			}

			const menuItem = document.createElement("div");
			menuItem.className = "context-menu-item";
			if (item.disabled) {
				menuItem.classList.add("disabled");
			}

			// Icon
			if (item.icon) {
				const iconEl = document.createElement("span");
				iconEl.className = `codicon codicon-${item.icon}`;
				menuItem.appendChild(iconEl);
			}

			// Label
			const labelEl = document.createElement("span");
			labelEl.className = "label";
			labelEl.textContent = item.label;
			menuItem.appendChild(labelEl);

			// Shortcut
			if (item.shortcut) {
				const shortcutEl = document.createElement("span");
				shortcutEl.className = "shortcut";
				shortcutEl.textContent = item.shortcut;
				menuItem.appendChild(shortcutEl);
			}

			// Submenu arrow
			if (item.submenu) {
				const arrowEl = document.createElement("span");
				arrowEl.className = "codicon codicon-chevron-right submenu-arrow";
				menuItem.appendChild(arrowEl);

				// Show submenu on hover (cancel any pending hide)
				menuItem.addEventListener("mouseenter", () => {
					this.cancelSubmenuHideTimer();
					this.showSubmenu(menuItem, item.submenu!);
				});
				menuItem.addEventListener("mouseleave", () => {
					// Start delayed hide - gives time for diagonal mouse movement
					this.scheduleSubmenuHide();
				});
			}

			// Click handler
			if (item.action && !item.disabled && !item.submenu) {
				menuItem.addEventListener("click", () => {
					this.hide();
					item.action!();
				});
			}

			menu.appendChild(menuItem);
		}

		return menu;
	}

	/** Show a submenu */
	private showSubmenu(parentItem: HTMLElement, items: ContextMenuItem[]): void {
		this.hideSubmenu();

		const parentRect = parentItem.getBoundingClientRect();
		const parentMenuRect = this.element?.getBoundingClientRect();
		const submenu = document.createElement("div");
		submenu.className = "context-menu context-submenu";

		for (const item of items) {
			const menuItem = document.createElement("div");
			menuItem.className = "context-menu-item";

			// Icon
			if (item.icon) {
				const iconEl = document.createElement("span");
				iconEl.className = `codicon codicon-${item.icon}`;
				menuItem.appendChild(iconEl);
			}

			// Label
			const labelEl = document.createElement("span");
			labelEl.className = "label";
			labelEl.textContent = item.label;
			menuItem.appendChild(labelEl);

			// Click handler
			if (item.action) {
				menuItem.addEventListener("click", () => {
					this.hide();
					item.action!();
				});
			}

			submenu.appendChild(menuItem);
		}

		document.body.appendChild(submenu);
		this.submenuElement = submenu;

		// Position submenu to the right of parent menu, or left if no space
		const submenuRect = submenu.getBoundingClientRect();
		const viewportWidth = window.innerWidth;

		if (parentRect.right + submenuRect.width <= viewportWidth) {
			// Fits on the right
			submenu.style.left = `${parentRect.right}px`;
		} else if (parentMenuRect && parentMenuRect.left - submenuRect.width >= 0) {
			// Position to the left of the parent menu
			submenu.style.left = `${parentMenuRect.left - submenuRect.width}px`;
		} else {
			// Fallback: position at left edge
			submenu.style.left = `${Math.max(0, viewportWidth - submenuRect.width)}px`;
		}
		submenu.style.top = `${parentRect.top}px`;

		// Adjust vertical position if needed
		const viewportHeight = window.innerHeight;
		if (parentRect.top + submenuRect.height > viewportHeight) {
			submenu.style.top = `${Math.max(0, viewportHeight - submenuRect.height)}px`;
		}

		// Cancel hide timer when entering submenu
		submenu.addEventListener("mouseenter", () => {
			this.cancelSubmenuHideTimer();
		});

		// Start delayed hide when leaving submenu
		submenu.addEventListener("mouseleave", () => {
			this.scheduleSubmenuHide();
		});
	}

	/** Schedule submenu to hide after delay */
	private scheduleSubmenuHide(): void {
		this.cancelSubmenuHideTimer();
		this.submenuHideTimer = setTimeout(() => {
			this.submenuHideTimer = null;
			this.hideSubmenu();
		}, SUBMENU_HIDE_DELAY);
	}

	/** Cancel any pending submenu hide */
	private cancelSubmenuHideTimer(): void {
		if (this.submenuHideTimer) {
			clearTimeout(this.submenuHideTimer);
			this.submenuHideTimer = null;
		}
	}

	/** Hide the submenu */
	private hideSubmenu(): void {
		this.cancelSubmenuHideTimer();
		if (this.submenuElement) {
			this.submenuElement.remove();
			this.submenuElement = null;
		}
	}

	/** Adjust menu position to stay within viewport */
	private adjustPosition(menu: HTMLElement, x: number, y: number): void {
		const rect = menu.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Adjust horizontal position
		if (rect.right > viewportWidth) {
			menu.style.left = `${Math.max(0, x - rect.width)}px`;
		}

		// Adjust vertical position
		if (rect.bottom > viewportHeight) {
			menu.style.top = `${Math.max(0, y - rect.height)}px`;
		}
	}

	/** Handle clicks outside the menu */
	private handleOutsideClick(e: Event): void {
		if (
			this.element &&
			!this.element.contains(e.target as Node) &&
			(!this.submenuElement || !this.submenuElement.contains(e.target as Node))
		) {
			this.hide();
		}
	}

	/** Destroy the context menu */
	destroy(): void {
		this.hide();
		document.removeEventListener("click", this.handleOutsideClick.bind(this));
		document.removeEventListener(
			"contextmenu",
			this.handleOutsideClick.bind(this),
		);
	}
}
