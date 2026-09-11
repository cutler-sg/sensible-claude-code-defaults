/**
 * Enough of the `vscode` module for the tree provider to be unit-tested outside
 * an extension host. Aliased onto the bare `vscode` specifier by
 * `vitest.config.ts`; the real module is supplied by the host at runtime and is
 * never bundled (see `esbuild.js`).
 */

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

export class TreeItem {
  id: string | undefined;
  iconPath: unknown;
  tooltip: string | undefined;
  contextValue: string | undefined;
  command: unknown;
  accessibilityInformation: { label: string } | undefined;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];

  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const at = this.listeners.indexOf(listener);
        if (at >= 0) this.listeners.splice(at, 1);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}
