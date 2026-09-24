// 単体テスト用の最小限の vscode（views の VSCode に依存しない部分だけ試すため）
export class EventEmitter<T> {
  event = (_l: (e: T) => void): { dispose(): void } => ({ dispose() {} });
  fire(_e?: T): void {}
}
