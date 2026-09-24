import { beforeAll, describe, expect, it } from 'vitest';
import { defaultIsShared, loadModel } from '../../src/core/load';
import { baseName, buildRefIndex, detectSoc, merge, resolveRef } from '../../src/core/merge';
import { parseLineMarkers } from '../../src/core/preprocess';
import { fx, setupParser } from '../helpers';

beforeAll(setupParser);

const load = (top: string, includes?: string[]) => loadModel({ cpp: 'cpp', top: fx(top), includes: includes?.map((i) => fx(i)) });

describe('merge', () => {
  it('UT-MRG-01 親子関係', async () => {
    const { model } = await load('override/board.dts');
    const pmic = model.byPath.get('/i2c@3000/pmic@20')!;
    expect(pmic.parent).toBe(model.byPath.get('/i2c@3000'));
    expect(model.root.children.map((c) => c.name)).toEqual(['i2c@3000', 'spi@4000']);
    expect(pmic.labels).toEqual(['pmic']);
    expect(model.byLabel.get('pmic')).toBe(pmic);
    expect(baseName(pmic.name)).toBe('pmic');
    expect(model.byPath.get('/')).toBe(model.root);
  });

  it('UT-MRG-02 上書きで最後が勝つ', async () => {
    const { model } = await load('override/board.dts');
    const i2c = model.byLabel.get('i2c1')!;
    expect(i2c.props.get('clock-frequency')!.value).toEqual([{ kind: 'cells', cells: [1000000] }]);
    expect(i2c.status).toBe('okay');
    expect(model.byLabel.get('spi0')!.status).toBe('disabled');
    expect(model.root.props.get('compatible')!.value).toEqual([
      { kind: 'string', value: 'acme,board' },
      { kind: 'string', value: 'acme,soc2' },
    ]);
  });

  it('UT-MRG-03 defs の順序', async () => {
    const { model } = await load('override/board.dts');
    const i2c = model.byLabel.get('i2c1')!;
    expect(i2c.defs.map((d) => [d.file.replace(fx('') + '/', ''), d.line, d.endLine])).toEqual([
      ['override/soc.dtsi', 6, 13],
      ['override/board.dtsi', 1, 4],
      ['override/board.dts', 10, 17],
    ]);
    const cf = i2c.props.get('clock-frequency')!;
    expect(cf.defs.map((d) => [d.file.replace(fx('') + '/', ''), d.line])).toEqual([
      ['override/soc.dtsi', 11],
      ['override/board.dtsi', 3],
      ['override/board.dts', 11],
    ]);
  });

  it('UT-MRG-04 delete', async () => {
    const { model, problems } = await load('delete/delete.dts');
    expect(problems).toEqual([]);
    expect([...model.byPath.keys()].sort()).toEqual(['/', '/keep@1', '/parent', '/parent/stay']);
    expect([...model.byLabel.get('keep')!.props.keys()]).toEqual(['reg', 'a']);
    expect(model.byLabel.has('gone')).toBe(false);
  });

  it('UT-MRG-05 raw（cpp 前の書き方）', async () => {
    const { model } = await load('macro/macro.dts', ['macro/include']);
    const dev = model.byPath.get('/dev')!;
    expect(dev.props.get('interrupts')!.raw).toBe('<ACME_IRQ(3) ACME_GPIO_ACTIVE_LOW>');
    expect(dev.props.get('interrupts')!.value).toEqual([{ kind: 'cells', cells: [35, 1] }]);
    expect(dev.props.get('speed')!.raw).toBe('<LOCAL_SPEED>');
    expect(model.root.props.get('model')!.raw).toBe('BOARD_NAME');
    expect(model.root.props.get('model')!.value).toEqual([{ kind: 'string', value: 'Macro Board' }]);
    expect(model.macros.get('LOCAL_SPEED')!.uses).toHaveLength(1);
  });

  it('値の種類', async () => {
    const { model } = await load('basic/basic.dts');
    const blob = model.byPath.get('/blob')!;
    const v = (n: string) => blob.props.get(n)!.value;
    expect(v('data')).toEqual([{ kind: 'bytes', bytes: [1, 2, 0xab] }]);
    expect(v('small')).toEqual([{ kind: 'cells', cells: [0x12, 0x34], bits: 8 }]);
    expect(v('wide')).toEqual([{ kind: 'cells', cells: [0x1234], bits: 16 }]);
    expect(v('big')).toEqual([{ kind: 'cells', cells: [0x100000000], bits: 64 }]);
    expect(v('expr')).toEqual([{ kind: 'cells', cells: [3, 0x100, 0xffffffff, 7] }]);
    expect(v('flag')).toEqual([{ kind: 'empty' }]);
    expect(v('mixed')).toEqual([{ kind: 'string', value: 'a' }, { kind: 'cells', cells: [1] }, { kind: 'bytes', bytes: [0xff] }]);
    expect(model.byPath.get('/chosen')!.props.get('stdout-path')!.value).toEqual([{ kind: 'string', value: '/serial@1000' }]);
    expect(model.byPath.get('/serial@2000')!.status).toBe('disabled');
    expect(model.soc).toBe('acme,soc1');
    expect(detectSoc(model.byPath.get('/blob')!)).toBeUndefined();
  });

  it('UT-MRG-06 refs と逆引き', async () => {
    const { model, problems } = await load('refs/refs.dts');
    expect(problems).toEqual([]);
    const led = model.byPath.get('/led')!;
    expect(led.props.get('gpios')!.refs).toEqual(['gpio0', 'gpio1']);
    expect(led.props.get('gpios')!.value).toEqual([
      { kind: 'cells', cells: [{ ref: 'gpio0' }, 5, 0] },
      { kind: 'cells', cells: [{ ref: 'gpio1' }, 6, 1] },
    ]);
    const user = model.byPath.get('/user')!;
    expect(user.props.get('ctrl')!.refs).toEqual(['/gpio@1']);
    expect(user.props.get('fwd')!.refs).toEqual(['late']);
    expect(model.byPath.get('/aliases')!.props.get('bypath')!.value).toEqual([{ kind: 'string', value: '/gpio@1' }]);
    expect(resolveRef(model, '/gpio@1')).toBe(model.byLabel.get('gpio1'));
    expect(resolveRef(model, 'late')!.path).toBe('/late-node');
    const { uses, usedBy } = buildRefIndex(model);
    expect(uses.get(led)!.map((e) => e.to.path)).toEqual(['/gpio@0', '/gpio@1']);
    const g1 = model.byLabel.get('gpio1')!;
    expect(usedBy.get(g1)!.map((e) => `${e.from.path}:${e.prop.name}`).sort()).toEqual(['/aliases:bypath', '/led:gpios', '/user:ctrl']);
  });

  it('UT-MRG-07 未定義 &label', async () => {
    const { model, problems } = await load('errors/errors.dts');
    const undef = problems.filter((p) => p.kind === 'undefined-label');
    expect(undef.map((p) => [p.message, p.loc?.line])).toEqual([
      ['ノード上書き: 未定義の参照 &missing', 20],
      ['ref: 未定義の参照 &nosuch', 16],
    ]);
    // 構文エラーの後ろも読めている
    expect(model.byPath.get('/after')!.props.get('ok')!.value).toEqual([{ kind: 'string', value: 'yes' }]);
    expect(model.byPath.get('/good')).toBeDefined();
    expect(problems.some((p) => p.kind === 'syntax')).toBe(true);
  });

  it('UT-MRG-08 shared 判定', async () => {
    const k = fx('kernel');
    const { model } = await loadModel({
      cpp: 'cpp',
      top: `${k}/arch/arm64/boot/dts/rockchip/rk3326-odroid-go2.dts`,
      includes: [`${k}/include`],
      workspaceRoots: [fx('')],
    });
    expect(model.soc).toBe('rockchip,rk3326');
    const i2c0 = model.byLabel.get('i2c0')!;
    expect(i2c0.defs.map((d) => [d.file.split('/').pop(), d.shared])).toEqual([
      ['px30.dtsi', true],
      ['rk3326-odroid-go.dtsi', false],
    ]);
    const gpioMacro = model.macros.get('GPIO_ACTIVE_LOW')!;
    expect(gpioMacro.def.shared).toBe(true);
    const shared = defaultIsShared(['/ws']);
    expect(shared('/other/x.dts', undefined)).toBe(true);
    expect(shared('/ws/include/dt-bindings/gpio/gpio.h', undefined)).toBe(true);
    expect(shared('/ws/rk3399-opp.dtsi', 'rockchip,rk3399')).toBe(true);
    expect(shared('/ws/rk3399-board.dtsi', 'rockchip,rk3399')).toBe(false);
    expect(shared('/ws/board.dts', undefined)).toBe(false);
    expect(shared('/ws/rk3399.dtsi', 'rockchip,rk3399')).toBe(true);
    expect(shared('/ws/common.dtsi', 'rockchip,rk3399')).toBe(false);
    expect(shared('/ws/arch/arm64/boot/dts/rockchip/px30.dtsi', 'rockchip,rk3326')).toBe(true);
  });

  it('/omit-if-no-ref/ とトップレベルの変なノード', async () => {
    const text = [
      '/ {',
      '  used: used { };',
      '  /omit-if-no-ref/ unused: unused { };',
      '  keep { p = <&used>; };',
      '};',
      '/omit-if-no-ref/ &used;',
      'stray { };',
      '/delete-node/ &nosuch;',
    ].join('\n');
    const pre = { ...parseLineMarkers(`# 1 "/v.dts"\n${text}\n`, '/'), stderr: '' };
    const { model, problems } = await merge({ pre, topFile: '/v.dts' });
    expect([...model.byPath.keys()].sort()).toEqual(['/', '/keep', '/used']);
    expect(problems.map((p) => p.kind).sort()).toEqual(['syntax', 'undefined-label']);
  });
});
