import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, findNodeAtLocation, modify, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import type { CategoryRule } from '../core/classify';

export interface ConfigError {
  file: string;
  /** 1 始まり */
  line: number;
  column: number;
  message: string;
}

export interface Profile {
  name: string;
  /** ワークスペースからの相対パス（絶対パスも可） */
  top: string;
  include: string[];
  defines: Record<string, string>;
  soc?: string;
}

export interface ProfilesConfig {
  profiles: Map<string, Profile>;
  default?: string;
  /** dtsi のファイル名 → プロファイル名 または トップ dts のパス */
  topByDtsi: Record<string, string>;
}

export interface LoadedConfig {
  categories: CategoryRule[];
  profiles: ProfilesConfig;
  errors: ConfigError[];
}

export const USER_DIR = '.dtviewer';
export const PROFILES_FILE = 'profiles.jsonc';
export const CATEGORIES_FILE = 'categories.jsonc';

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

class JsoncDoc {
  readonly errors: ConfigError[] = [];
  readonly root: Node | undefined;

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    const errs: ParseError[] = [];
    this.root = parseTree(text, errs, { allowTrailingComma: true, disallowComments: false });
    for (const e of errs) this.error(e.offset, `JSONC の書式ミス: ${printParseErrorCode(e.error)}`);
  }

  error(offset: number, message: string): void {
    this.errors.push({ file: this.file, ...lineCol(this.text, offset), message });
  }

  line(node: Node): number {
    return lineCol(this.text, node.offset).line;
  }

  endLine(node: Node): number {
    return lineCol(this.text, node.offset + node.length).line;
  }
}

function strArray(doc: JsoncDoc, node: Node | undefined, what: string): string[] | undefined {
  if (!node) return undefined;
  if (node.type !== 'array') {
    doc.error(node.offset, `${what} は文字列の配列にしてください`);
    return undefined;
  }
  const out: string[] = [];
  for (const c of node.children ?? []) {
    if (c.type === 'string') out.push(c.value as string);
    else doc.error(c.offset, `${what} は文字列の配列にしてください`);
  }
  return out;
}

function readDoc(file: string): JsoncDoc | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return new JsoncDoc(file, text);
}

/** categories.jsonc を読む。書式ミスがあれば rules は空で errors に入る。 */
export function parseCategories(file: string, text: string): { rules: CategoryRule[]; errors: ConfigError[] } {
  const doc = new JsoncDoc(file, text);
  const rules: CategoryRule[] = [];
  const list = doc.root && findNodeAtLocation(doc.root, ['categories']);
  if (doc.errors.length === 0) {
    if (!list || list.type !== 'array') doc.error(doc.root?.offset ?? 0, '"categories" の配列がありません');
    else {
      for (const c of list.children ?? []) {
        const id = findNodeAtLocation(c, ['id']);
        if (c.type !== 'object' || id?.type !== 'string') {
          doc.error(c.offset, 'カテゴリには文字列の "id" が必要です');
          continue;
        }
        const label = findNodeAtLocation(c, ['label']);
        const group = findNodeAtLocation(c, ['group']);
        rules.push({
          id: id.value as string,
          label: label?.type === 'string' ? (label.value as string) : (id.value as string),
          group: group?.type === 'string' ? (group.value as string) : 'その他',
          match: {
            compatible: strArray(doc, findNodeAtLocation(c, ['match', 'compatible']), 'match.compatible'),
            nodeName: strArray(doc, findNodeAtLocation(c, ['match', 'nodeName']), 'match.nodeName'),
          },
          source: { file, line: doc.line(c), endLine: doc.endLine(c), shared: false },
        });
      }
    }
  }
  return doc.errors.length ? { rules: [], errors: doc.errors } : { rules, errors: [] };
}

/** ユーザー側のルールを先に置き、同じ id の内蔵ルールは捨てる */
export function mergeCategories(builtin: CategoryRule[], user: CategoryRule[]): CategoryRule[] {
  const ids = new Set(user.map((r) => r.id));
  return [...user, ...builtin.filter((r) => !ids.has(r.id))];
}

export function emptyProfiles(): ProfilesConfig {
  return { profiles: new Map(), topByDtsi: {} };
}

/** profiles.jsonc を読む。書式ミスがあればプロファイル無しとして errors に入る。 */
export function parseProfiles(file: string, text: string): { profiles: ProfilesConfig; errors: ConfigError[] } {
  const doc = new JsoncDoc(file, text);
  const out = emptyProfiles();
  if (doc.errors.length === 0 && doc.root) {
    const profs = findNodeAtLocation(doc.root, ['profiles']);
    if (profs && profs.type !== 'object') doc.error(profs.offset, '"profiles" はオブジェクトにしてください');
    for (const prop of profs?.type === 'object' ? (profs.children ?? []) : []) {
      const [keyNode, val] = prop.children ?? [];
      const name = keyNode?.value as string;
      if (!val || val.type !== 'object') {
        doc.error(prop.offset, `プロファイル ${name} はオブジェクトにしてください`);
        continue;
      }
      const top = findNodeAtLocation(val, ['top']);
      if (top?.type !== 'string') {
        doc.error(val.offset, `プロファイル ${name} に文字列の "top" がありません`);
        continue;
      }
      const defines: Record<string, string> = {};
      const defs = findNodeAtLocation(val, ['defines']);
      if (defs && defs.type !== 'object') doc.error(defs.offset, '"defines" はオブジェクトにしてください');
      for (const d of defs?.type === 'object' ? (defs.children ?? []) : []) {
        const [k, v] = d.children ?? [];
        if (!k || !v) continue;
        if (v.type === 'string' || v.type === 'number' || v.type === 'boolean') defines[k.value as string] = String(v.value);
        else doc.error(v.offset, `defines.${String(k.value)} は文字列か数値にしてください`);
      }
      const soc = findNodeAtLocation(val, ['soc']);
      out.profiles.set(name, {
        name,
        top: top.value as string,
        include: strArray(doc, findNodeAtLocation(val, ['include']), 'include') ?? [],
        defines,
        soc: soc?.type === 'string' ? (soc.value as string) : undefined,
      });
    }
    const def = findNodeAtLocation(doc.root, ['default']);
    if (def?.type === 'string') {
      out.default = def.value as string;
      if (!out.profiles.has(out.default)) doc.error(def.offset, `default のプロファイル ${out.default} がありません`);
    }
    const tbd = findNodeAtLocation(doc.root, ['topByDtsi']);
    for (const d of tbd?.type === 'object' ? (tbd.children ?? []) : []) {
      const [k, v] = d.children ?? [];
      if (k && v?.type === 'string') out.topByDtsi[k.value as string] = v.value as string;
    }
  }
  return doc.errors.length ? { profiles: emptyProfiles(), errors: doc.errors } : { profiles: out, errors: [] };
}

/** 内蔵（resourcesDir）とユーザー（workspaceRoot/.dtviewer）の設定を読んで合成する。 */
export function loadConfig(resourcesDir: string, workspaceRoot?: string): LoadedConfig {
  const errors: ConfigError[] = [];
  const builtinFile = path.join(resourcesDir, CATEGORIES_FILE);
  const builtin = readDoc(builtinFile);
  const b = builtin ? parseCategories(builtinFile, builtin.text) : { rules: [], errors: [] };
  errors.push(...b.errors);
  let categories = b.rules;
  let profiles = emptyProfiles();
  if (workspaceRoot) {
    const ucFile = path.join(workspaceRoot, USER_DIR, CATEGORIES_FILE);
    const uc = readDoc(ucFile);
    if (uc) {
      const u = parseCategories(ucFile, uc.text);
      errors.push(...u.errors);
      categories = mergeCategories(categories, u.rules);
    }
    const upFile = path.join(workspaceRoot, USER_DIR, PROFILES_FILE);
    const up = readDoc(upFile);
    if (up) {
      const p = parseProfiles(upFile, up.text);
      errors.push(...p.errors);
      profiles = p.profiles;
    }
  }
  return { categories, profiles, errors };
}

/** profiles.jsonc の topByDtsi に選択を記憶する（コメントは残す）。 */
export function rememberTopByDtsi(workspaceRoot: string, dtsiName: string, value: string): void {
  const file = path.join(workspaceRoot, USER_DIR, PROFILES_FILE);
  let text = '{\n}\n';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const edits = modify(text, ['topByDtsi', dtsiName], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  fs.writeFileSync(file, applyEdits(text, edits));
}

/** SoC の判定。プロファイルに書いてあればそれ、無ければルート compatible から */
export function resolveSoc(profile: Profile | undefined, rootCompatibleSoc: string | undefined): string | undefined {
  return profile?.soc ?? rootCompatibleSoc;
}
