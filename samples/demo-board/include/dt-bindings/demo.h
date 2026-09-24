/* サンプル用の定数（実在の SoC とは関係ありません） */
#ifndef _DT_BINDINGS_DEMO_H
#define _DT_BINDINGS_DEMO_H

#define GPIO_ACTIVE_HIGH	0
#define GPIO_ACTIVE_LOW		1

#define IRQ_TYPE_LEVEL_HIGH	4
#define DEMO_IRQ(n)		(32 + (n))

#define DEMO_CLK_UART0		10
#define DEMO_CLK_UART1		11
#define DEMO_CLK_I2C0		20
#define DEMO_CLK_SPI0		30
#define DEMO_CLK_EMMC		40
#define DEMO_CLK_SDMMC		41
#define DEMO_CLK_VOP		50

#endif
