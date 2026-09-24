# カーネル由来のテスト用ファイル

Linux カーネル v6.12（https://github.com/torvalds/linux/tree/v6.12）から、正解比較テスト用にそのまま写したものです。

- `arch/arm64/boot/dts/rockchip/rk3326-odroid-go2.dts` ほか rk3326 / px30 / rk3328 系の dts・dtsi
- それらが include する `include/dt-bindings/` のヘッダ
  - `include/dt-bindings/input/linux-event-codes.h` はカーネルではシンボリックリンク（`include/uapi/linux/input-event-codes.h` を指す）なので、中身を写しています

**ライセンス**: 各ファイルの先頭の `SPDX-License-Identifier` に従います（`GPL-2.0+ OR MIT`、`GPL-2.0`、`GPL-2.0-only` など）。
このリポジトリ本体の MIT ライセンスはこれらのファイルには適用されません。
これらはテストにだけ使い、拡張の配布物（.vsix）には含めません。
