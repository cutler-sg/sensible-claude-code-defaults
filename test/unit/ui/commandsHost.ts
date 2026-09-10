/**
 * A `vscode` stand-in for the *command* surface — `window` dialogs, command
 * registration, `workspace` documents and configuration.
 *
 * Deliberately separate from `vscodeStub.ts`, which models the tree-item side
 * of the API: these two files are edited by different work, and a shared stub
 * that grows a field for one of them keeps breaking the other. Each records
 * what it was asked to show so a test can assert on the *dialogue*, which is
 * the whole behaviour under test for a command that writes to a user's file.
 */

export interface Shown {
  message: string;
  options?: unknown;
  items: string[];
}

export interface QuickPickCall {
  items: unknown[];
  options?: unknown;
}

export interface InputBoxCall {
  options: InputBoxOptions;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (value: string) => unknown;
}

type Answer = (call: QuickPickCall) => unknown;

export const state = {
  info: [] as Shown[],
  warn: [] as Shown[],
  error: [] as Shown[],
  quickPicks: [] as QuickPickCall[],
  inputBoxes: [] as InputBoxCall[],
  progressTitles: [] as string[],
  executed: [] as { command: string; args: unknown[] }[],
  registered: new Map<string, (...args: unknown[]) => Promise<void>>(),
  opened: [] as string[],
  shownDocuments: [] as unknown[],
  /** The `TextDocumentShowOptions` each `showTextDocument` received, if any. */
  showOptions: [] as unknown[],
  configuration: new Map<string, unknown>(),
  /** Thrown by `workspace.openTextDocument` when set (absent settings file). */
  openFailure: undefined as Error | undefined,
  /** Answers the next QuickPick; default cancels. */
  quickPickAnswer: (() => undefined) as Answer,
  /** Answers the next input box; default cancels (returns undefined). */
  inputBoxAnswer: ((_call: InputBoxCall) => undefined) as (
    call: InputBoxCall,
  ) => string | undefined,
  /** Answers a modal/notification by message; default dismisses. */
  answer: ((_shown: Shown) => undefined) as (shown: Shown) => string | undefined,
  /** What `env.clipboard.writeText` last received (FR-7.1). */
  clipboard: "",
  /** What `extensions.getExtension` reports for Claude Code. */
  claudeCodeVersion: undefined as string | undefined,
  /** `env.remoteName`: undefined is a local window. */
  remoteName: undefined as string | undefined,
};

export function reset(): void {
  state.info = [];
  state.warn = [];
  state.error = [];
  state.quickPicks = [];
  state.inputBoxes = [];
  state.progressTitles = [];
  state.executed = [];
  state.registered = new Map();
  state.opened = [];
  state.shownDocuments = [];
  state.showOptions = [];
  state.configuration = new Map();
  state.openFailure = undefined;
  state.quickPickAnswer = () => undefined;
  state.inputBoxAnswer = () => undefined;
  state.answer = () => undefined;
  state.clipboard = "";
  state.claudeCodeVersion = undefined;
  state.remoteName = undefined;
}

function record(into: Shown[], message: string, rest: unknown[]): Promise<string | undefined> {
  // The real API takes either (message, ...items) or (message, options, ...items).
  const hasOptions = rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null;
  const shown: Shown = {
    message,
    ...(hasOptions ? { options: rest[0] } : {}),
    items: (hasOptions ? rest.slice(1) : rest) as string[],
  };
  into.push(shown);
  return Promise.resolve(state.answer(shown));
}

export const window = {
  showInformationMessage: (message: string, ...rest: unknown[]) =>
    record(state.info, message, rest),
  showWarningMessage: (message: string, ...rest: unknown[]) => record(state.warn, message, rest),
  showErrorMessage: (message: string, ...rest: unknown[]) => record(state.error, message, rest),
  showQuickPick: async (items: unknown, options?: unknown) => {
    const call: QuickPickCall = {
      items: (await items) as unknown[],
      ...(options ? { options } : {}),
    };
    state.quickPicks.push(call);
    return state.quickPickAnswer(call);
  },
  showTextDocument: async (document: unknown, options?: unknown) => {
    state.shownDocuments.push(document);
    if (options !== undefined) state.showOptions.push(options);
  },
  showInputBox: (options: InputBoxOptions = {}) => {
    const call: InputBoxCall = { options };
    state.inputBoxes.push(call);
    return Promise.resolve(state.inputBoxAnswer(call));
  },
  /**
   * The real API runs the task immediately and shows progress around it, so the
   * stub does the same: a flow's behaviour must not depend on whether a
   * notification is rendered.
   */
  withProgress: async <T>(options: { title?: string }, task: () => Promise<T>): Promise<T> => {
    if (options.title !== undefined) state.progressTitles.push(options.title);
    return task();
  },
};

export enum InputBoxValidationSeverity {
  Ignore = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const workspace = {
  openTextDocument: async (uri: { fsPath: string }) => {
    if (state.openFailure) throw state.openFailure;
    state.opened.push(uri.fsPath);
    return { uri };
  },
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T): T =>
      state.configuration.has(key) ? (state.configuration.get(key) as T) : fallback,
  }),
  workspaceFolders: undefined,
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => {
    state.registered.set(id, handler);
    return { dispose: () => state.registered.delete(id) };
  },
  executeCommand: async (command: string, ...args: unknown[]) => {
    state.executed.push({ command, args });
    const handler = state.registered.get(command);
    if (handler) await handler(...args);
  },
};

export const Uri = {
  file: (fsPath: string) => ({ fsPath }),
};

/** Enough of the position API for `openLeakedFile` to place a cursor. */
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

/** A fixed VS Code version, so a diagnostics assertion is deterministic. */
export const version = "1.98.2";

export const env = {
  get remoteName(): string | undefined {
    return state.remoteName;
  },
  clipboard: {
    writeText: (text: string): Promise<void> => {
      state.clipboard = text;
      return Promise.resolve();
    },
  },
};

export const extensions = {
  getExtension: (id: string) =>
    id === "anthropic.claude-code" && state.claudeCodeVersion !== undefined
      ? { packageJSON: { version: state.claudeCodeVersion } }
      : undefined,
};

export const Disposable = {
  from: (...disposables: { dispose(): void }[]) => ({
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  }),
};

/** Invoke a registered command the way the palette would. */
export function run(id: string, ...args: unknown[]): Promise<void> {
  const handler = state.registered.get(id);
  if (handler === undefined) throw new Error(`command not registered: ${id}`);
  return handler(...args);
}

/** Every message shown, in the order the user would have seen them. */
export function messages(): string[] {
  return [...state.info, ...state.warn, ...state.error].map((shown) => shown.message);
}
