/**
 * Custom context menu component for the terminal list.
 * Uses CSS styling to match VS Code's look and feel.
 */

import type { TerminalGroup } from "../types/messages";
import type { TerminalId } from "../types/terminal";

/** VS Code terminal color palette */
const TERMINAL_COLORS = [
	{ name: "red", value: "#f14c4c" },
	{ name: "orange", value: "#f5a623" },
	{ name: "yellow", value: "#e2c541" },
	{ name: "green", value: "#4fb86e" },
	{ name: "blue", value: "#3b8eea" },
	{ name: "purple", value: "#a95ec7" },
	{ name: "magenta", value: "#e3699e" },
	{ name: "cyan", value: "#4ec9b0" },
] as const;

/** Terminal icon options */
const TERMINAL_ICONS = [
	"terminal",
	"terminal-bash",
	"terminal-cmd",
	"terminal-powershell",
	"star",
	"flame",
	"bug",
	"beaker",
	"rocket",
	"heart",
	"zap",
	"cloud",
] as const;

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
	onColorChange: (id: TerminalId, color: string) => void;
	onIconChange: (id: TerminalId, icon: string) => void;
	onRename: (id: TerminalId) => void;
	onKill: (id: TerminalId) => void;
}

/**
 * Context Menu controller.
 * Displays a custom context menu at the specified position.
 */
export class ContextMenu {
	private element: HTMLElement | null = null;
	private submenuElement: HTMLElement | null = null;
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

	/** Hide the context menu */
	hide(): void {
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

		// Change Color
		items.push({
			label: "Change Color...",
			icon: "symbol-color",
			submenu: TERMINAL_COLORS.map((color) => ({
				label: color.name.charAt(0).toUpperCase() + color.name.slice(1),
				action: () => this.events.onColorChange(terminalId, color.value),
			})),
		});

		// Change Icon
		items.push({
			label: "Change Icon...",
			icon: "symbol-misc",
			submenu: TERMINAL_ICONS.map((icon) => ({
				label: icon,
				icon: icon,
				action: () => this.events.onIconChange(terminalId, icon),
			})),
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

				// Show submenu on hover
				menuItem.addEventListener("mouseenter", () => {
					this.showSubmenu(menuItem, item.submenu!);
				});
				menuItem.addEventListener("mouseleave", (e) => {
					// Only hide if not moving to submenu
					const related = e.relatedTarget as HTMLElement;
					if (!this.submenuElement?.contains(related)) {
						this.hideSubmenu();
					}
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

		const rect = parentItem.getBoundingClientRect();
		const submenu = document.createElement("div");
		submenu.className = "context-menu context-submenu";
		submenu.style.left = `${rect.right}px`;
		submenu.style.top = `${rect.top}px`;

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

		// Keep submenu visible when hovering over it
		submenu.addEventListener("mouseleave", () => {
			this.hideSubmenu();
		});

		// Adjust position
		this.adjustPosition(submenu, rect.right, rect.top);
	}

	/** Hide the submenu */
	private hideSubmenu(): void {
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
