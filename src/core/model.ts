/** 行は 1 始まり（cpp の行マーカーと同じ）。 */
export interface SourceLoc {
  file: string;
  line: number;
  endLine: number;
  shared: boolean;
}

export interface DtNode {
  path: string;
  name: string;
  labels: string[];
  props: Map<string, DtProp>;
  children: DtNode[];
  parent?: DtNode;
  /** 書かれた場所（&label 上書き含む、書かれた順。末尾が効いている） */
  defs: SourceLoc[];
  status: 'okay' | 'disabled' | 'unknown';
  category?: CategoryResult;
}

export interface DtProp {
  name: string;
  value: DtValue[];
  /** cpp 前の書き方（マクロ名のまま） */
  raw: string;
  defs: SourceLoc[];
  /** 参照している &label（label 名）/ パス（"/" 始まり） */
  refs: string[];
}

export type DtValue =
  /** bits は /bits/ 指定があるときだけ入る（省略時 32） */
  | { kind: 'cells'; cells: (number | { ref: string })[]; bits?: 8 | 16 | 32 | 64 }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; bytes: number[] }
  | { kind: 'empty' };

export interface CategoryResult {
  id: string;
  reason: string;
  ruleSource?: SourceLoc;
}

export interface MacroDef {
  name: string;
  value: string;
  def: SourceLoc;
  uses: SourceLoc[];
}

export interface DtModel {
  root: DtNode;
  byLabel: Map<string, DtNode>;
  byPath: Map<string, DtNode>;
  macros: Map<string, MacroDef>;
  topFile: string;
  files: string[];
  soc?: string;
}

/** 読み込み中に見つかった問題（未定義 &label、構文エラーなど） */
export interface Problem {
  kind: 'undefined-label' | 'undefined-path' | 'syntax' | 'preprocess';
  message: string;
  loc?: SourceLoc;
}
