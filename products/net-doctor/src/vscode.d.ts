declare module "vscode" {
  export interface Disposable {
    dispose(): void;
  }

  export interface ExtensionContext {
    subscriptions: Disposable[];
  }

  export interface OutputChannel extends Disposable {
    appendLine(value: string): void;
    clear(): void;
    show(preserveFocus?: boolean): void;
  }

  export namespace commands {
    export function registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
    ): Disposable;
  }

  export namespace window {
    export function createOutputChannel(name: string): OutputChannel;
    export function showInputBox(options?: {
      ignoreFocusOut?: boolean;
      placeHolder?: string;
      prompt?: string;
      title?: string;
      value?: string;
      validateInput?: (value: string) => string | undefined | null;
    }): Promise<string | undefined>;
    export function showInformationMessage(message: string): Promise<string | undefined>;
    export function showErrorMessage(message: string): Promise<string | undefined>;
    export function withProgress<T>(
      options: {
        location: ProgressLocation;
        title?: string;
        cancellable?: boolean;
      },
      task: () => Promise<T>,
    ): Promise<T>;
  }

  export enum ProgressLocation {
    Notification = 15,
  }
}
