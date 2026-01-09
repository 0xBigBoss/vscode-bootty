import * as vscode from "vscode";
import type { TerminalId } from "./types/terminal";

/**
 * Tree item representing a terminal in the terminal list TreeView.
 * Each item stores the terminal ID for selection routing.
 */
export class TerminalTreeItem extends vscode.TreeItem {
	constructor(
		public readonly terminalId: TerminalId,
		public readonly label: string,
		public readonly isActive: boolean,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);

		this.id = terminalId;
		this.contextValue = "terminal";
		this.iconPath = new vscode.ThemeIcon("terminal");

		// Visual indicator for active terminal
		if (isActive) {
			this.iconPath = new vscode.ThemeIcon(
				"terminal",
				new vscode.ThemeColor("terminal.ansiGreen"),
			);
			this.description = "(active)";
		}

		// Command to activate terminal on click
		this.command = {
			command: "bootty.selectTerminal",
			title: "Select Terminal",
			arguments: [terminalId],
		};
	}
}

/** Terminal entry for the tree data provider */
export interface TerminalEntry {
	id: TerminalId;
	title: string;
	active: boolean;
}

/** Callback to handle terminal selection in the tree */
export type TerminalSelectHandler = (terminalId: TerminalId) => void;

/** Callback to handle terminal close request from context menu */
export type TerminalCloseHandler = (terminalId: TerminalId) => void;

/**
 * TreeDataProvider for the terminal list sidebar.
 * Displays all panel terminals with selection and context menu support.
 */
export class TerminalTreeDataProvider
	implements vscode.TreeDataProvider<TerminalTreeItem>
{
	private _onDidChangeTreeData = new vscode.EventEmitter<
		TerminalTreeItem | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _terminals: TerminalEntry[] = [];
	private _selectHandler?: TerminalSelectHandler;
	private _closeHandler?: TerminalCloseHandler;
	private _treeView?: vscode.TreeView<TerminalTreeItem>;

	/** Set the handler for terminal selection events */
	setSelectHandler(handler: TerminalSelectHandler): void {
		this._selectHandler = handler;
	}

	/** Set the handler for terminal close events */
	setCloseHandler(handler: TerminalCloseHandler): void {
		this._closeHandler = handler;
	}

	/** Store reference to tree view for selection management */
	setTreeView(treeView: vscode.TreeView<TerminalTreeItem>): void {
		this._treeView = treeView;
	}

	/** Update the terminal list and refresh the tree */
	setTerminals(terminals: TerminalEntry[]): void {
		this._terminals = terminals;
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Add a terminal to the list */
	addTerminal(entry: TerminalEntry): void {
		this._terminals.push(entry);
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Remove a terminal from the list */
	removeTerminal(terminalId: TerminalId): void {
		this._terminals = this._terminals.filter((t) => t.id !== terminalId);
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Update a terminal's title */
	renameTerminal(terminalId: TerminalId, title: string): void {
		const terminal = this._terminals.find((t) => t.id === terminalId);
		if (terminal) {
			terminal.title = title;
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	/** Set the active terminal (updates visual indicator) */
	setActiveTerminal(terminalId: TerminalId): void {
		for (const terminal of this._terminals) {
			terminal.active = terminal.id === terminalId;
		}
		this._onDidChangeTreeData.fire(undefined);

		// Also update tree selection to match active terminal
		if (this._treeView) {
			const activeTerminal = this._terminals.find((t) => t.active);
			if (activeTerminal) {
				const item = new TerminalTreeItem(
					activeTerminal.id,
					activeTerminal.title,
					true,
				);
				this._treeView.reveal(item, { select: true, focus: false });
			}
		}
	}

	/** Handle terminal selection (called by command) */
	handleSelect(terminalId: TerminalId): void {
		this._selectHandler?.(terminalId);
	}

	/** Handle terminal close (called by context menu command) */
	handleClose(terminalId: TerminalId): void {
		this._closeHandler?.(terminalId);
	}

	/** Get the currently active terminal ID */
	getActiveTerminalId(): TerminalId | undefined {
		return this._terminals.find((t) => t.active)?.id;
	}

	/** Get ordered terminal IDs */
	getTerminalIds(): TerminalId[] {
		return this._terminals.map((t) => t.id);
	}

	// TreeDataProvider implementation

	getTreeItem(element: TerminalTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(
		element?: TerminalTreeItem,
	): vscode.ProviderResult<TerminalTreeItem[]> {
		// Root level: return all terminals
		if (!element) {
			return this._terminals.map(
				(t) => new TerminalTreeItem(t.id, t.title, t.active),
			);
		}
		// Terminals have no children
		return [];
	}

	getParent(
		_element: TerminalTreeItem,
	): vscode.ProviderResult<TerminalTreeItem> {
		// Flat list, no parent
		return undefined;
	}
}
