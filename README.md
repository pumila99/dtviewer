# DTビューア（仮）

デバイスツリー（`.dts` / `.dtsi`）を、**cpp を通したあとの合算結果**でツリー表示する VSCode 拡張です。
`&label` での上書きや `/delete-node/` を反映した「最終的に効いている形」を見ながら、元のファイル・行へ飛べます。

## 使い方（概要）

1. カーネルや Buildroot のソースツリーをワークスペースとして開きます（Linux の VSCode、または Windows から Remote-WSL）。
2. `.dts` / `.dtsi` を開くと、アクティビティバーの **DTビューア** に構造が出ます。
   - `.dts` を開いたらそれがトップになります。
   - `.dtsi` を開いたら、それを include している `.dts` を探します（複数あれば選択、選んだものは記憶）。
   - だれも include していない `.dtsi` は単体で部分表示します。
3. ツリーの項目をクリックすると、効いている場所（最後に書かれた場所）を横のエディタで開いて範囲選択します。
   右クリックの「エディタで開く」では、書かれた場所が複数あれば一覧から選べます。
4. エディタでカーソルを動かすと、そのノードがツリーで選択されます。
5. ファイルを**保存したとき**に読み直します（未保存の内容は反映しません）。

ツリー上部のボタンで「カテゴリ別 ⇔ アドレス順」「disabled を隠す」を切り替えられます。
ステータスバーには `DT: <プロファイル名> | <SoC>` が出ます。

## 必要なもの

- `cpp`（C プリプロセッサ）。PATH → Buildroot の `output/host/bin`（`<triplet>-cpp` も可）の順で自動で探します。
- 拡張は dts ファイルを書き換えません。

## 設定（任意）

ワークスペースの `.dtviewer/` に JSONC で置きます。書式ミスがあっても内蔵設定で動き続け、ファイルと行を知らせます。

```jsonc
// .dtviewer/profiles.jsonc
{
  "profiles": {
    "DM1000": {
      "top": "arch/arm64/boot/dts/rockchip/rk3326-dm1000.dts",
      "include": ["include", "arch/arm64/boot/dts"],
      "defines": { "USE_LCD": "1" },
      "soc": "rockchip,rk3326"      // 省略時はルート compatible から判定
    }
  },
  "default": "DM1000",
  "topByDtsi": { "rk3326.dtsi": "DM1000" }   // dtsi を開いたときの選択の記憶
}
```

```jsonc
// .dtviewer/categories.jsonc（内蔵は resources/categories.jsonc。同じ id はユーザー側が勝つ）
{
  "categories": [
    { "id": "uart", "label": "UART", "group": "通信",
      "match": { "compatible": ["*uart*", "*serial*"], "nodeName": ["serial@*"] } }
  ]
}
```

分類は、全ルールを上から compatible で試し、外れたら上からノード名で試します。どれにも当たらなければ「その他」です。

## 開発

ビルド・テスト・`.vsix` 作成は GitHub Actions で行います（`.github/workflows/ci.yml`）。

| スクリプト | 中身 |
| --- | --- |
| `npm run lint` | eslint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | vitest（単体テスト） |
| `npm run test:gt` | 正解比較テスト（cpp → dtc → `dtc -I dtb -O dts` と比べる） |
| `npm run test:it` | 画面テスト（@vscode/test-electron） |
| `npm run build` | esbuild で `dist/extension.js` |
| `npm run package` | `vsce package` |

`test/fixtures/kernel/` には Linux カーネル v6.12 の rk3326 / rk3328 系 dts と dt-bindings ヘッダを、テスト用に元のライセンスのまま同梱しています（`test/fixtures/kernel/README.md`）。拡張の配布物（.vsix）には入りません。

## ライセンス

MIT
