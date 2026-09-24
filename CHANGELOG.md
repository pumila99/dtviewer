# Changelog

## 0.1.0

- 最初の版
  - cpp 後のテキストから合算ツリー（DtModel）を作る。位置は cpp の行マーカーで元ファイル・行に戻す
  - `&label` 上書き・`/delete-node/`・`/delete-property/`・`/omit-if-no-ref/` を反映。未定義の `&label` を検出
  - `#define` の索引、cpp 前の書き方（raw）の保持
  - カテゴリ分類（内蔵ルール＋`.dtviewer/categories.jsonc`）と分類理由
  - トップ dts の自動決定（プロファイル → dts → dtsi の逆引き → dtsi 単体）
  - 構造ビュー（カテゴリ別／アドレス順、disabled を隠す、ツールチップ、エディタとの連動）
  - ステータスバー `DT: <プロファイル名> | <SoC>`
  - 機能ごとの free / pro 区分表と判定関数
