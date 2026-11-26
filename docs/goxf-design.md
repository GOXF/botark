# BotArk 分叉（goxf）设计规范

适用于 goxf/portable 上所有新写的界面代码和效果图。数值取自
`src/renderer/src/styles/globals.css` 和 `src/renderer/src/components/ui/*.tsx`
（2026-11-26 版），来源是已确认的收敛提案（字号 7 档、圆角 5 档、颜色只用 token）。

> 一句话：**用 ui 组件、用 token、用档位里的值**。不在档位里的值不要新写；
> 上游带进来的旧值由 `goxf-scale.css` 统一归档（见「上游合并」）。

---

## 1. 字号（7 档 + 1 个例外）

写法统一用 `text-[Npx]`（与现有代码一致，脚本好查）。`text-ui` = 14px / 行高 22px，
`text-caption` = 12px / 行高 16px，两个 token 可以继续用，等同 14 / 12 档
（注意 globals.css 注释写的是 13/11，实际值是 14/12，以值为准）。

| 档 | 用途 | 现有出处 |
|---|---|---|
| 11 | 标签、角标文字、时间戳、计数胶囊（「3 个 Bot」） | 分组计数 `text-[11px]` |
| 12 | 次要说明：设置行描述、菜单快捷键提示、MenuLabel、表单 hint/error、`Button size="sm"` 文字、`SegmentedControl size="sm"` 文字 | Button sm、MenuItem hint、Field hint |
| 13 | 列表行、菜单项、小正文、页副标题、弹窗描述、`SegmentedControl size="md"` | MenuItem、Dialog 描述 |
| 14 | 正文、控件文字、设置行标题、输入框、`Button md/lg` | Button md、TextInput（text-ui） |
| 15 | 弹窗标题 | Dialog Title |
| 17 | 页标题（设置分区标题等） | 「常规与安全」 h2 |
| 28 | 引导页 / 空状态大标题 | — |
| **10** | **只给未读数字**（`UnreadBadge`），别处不用 | Status.tsx |

旧值归档：9–10.5→11，11.5→12，12.5→13，13.5→14，14.5/16→15，18/20/22→17，26–32→28。
（`SegmentedControl size="xs"` 目前是 11.5px，由 goxf-scale.css 归到 12。）

**字重**只用 `font-medium`（标题、控件、强调）和 `font-semibold`（页标题、弹窗标题、数字角标）。
`font-bold` 一律当 semibold；正文不写字重。

## 2. 圆角（5 档）

| 档 | 用途 |
|---|---|
| `rounded-md` | 列表项、菜单项（MenuItem）、行内小高亮 |
| `rounded-lg` | 输入框（TextInput）、小块、代码块 |
| `rounded-xl` | 菜单/弹层（MENU_SURFACE）、小卡片 |
| `rounded-2xl` | 卡片、弹窗（Dialog）、设置分组卡 |
| `rounded-full` | 按钮（Button / IconButton）、头像、角标、胶囊、SegmentedControl |

裸 `rounded` → `rounded-md`；`rounded-3xl` → `rounded-2xl`；`rounded-[Npx]` 不新写。

## 3. 颜色（只用 token）

不写 `#hex`、`white/black`、`amber/orange/emerald/...` 等 Tailwind 调色板颜色。
唯一例外：`Button variant="primary"` 和 `UnreadBadge` 在实心 accent 上用的 `text-white`（组件内部已写好，不要在外面再写）。

### 3.1 中性色

| token（类名前缀 bg-/text-/border-） | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `canvas` | #f5f5f5 | #0e0e0e | 窗口底 |
| `main` | #ffffff | #161616 | 主内容区、菜单/弹窗面 |
| `surface` | #ffffff | #1f1f1f | 卡片 |
| `surface-hover` | ink 6% | 6% | 卡片悬停 |
| `bubble` | ink 6% | 6% | 对方气泡 |
| `bubble-user` | #1c1c1c | #f5f5f5 | 自己的气泡 |
| `hover` | ink 6% | 6% | 悬停底、次要按钮底、分段控件槽 |
| `active` | ink 9% | 10% | 按下 / 选中底 |
| `sunken` | ink 4% | 5% | 凹陷区、计数胶囊底 |
| `line` | ink 8% | 8% | 分隔线、卡片边 |
| `line-strong` | ink 14% | 14% | 输入框边、菜单/弹窗 0.5px 边 |
| `ink` | #1c1c1c | #f5f5f5 | 主文字 |
| `ink-secondary` | ink 68% | 68% | 次级文字、ghost 按钮 |
| `ink-muted` | ink 52% | 50% | 说明文字、占位符 |
| `ink-faint` | ink 34% | 32% | 禁用感文字、极弱提示 |

（浅色 ink = rgb(28 28 28)，深色 = rgb(245 245 245)。）

### 3.2 强调色（accent）

| token | 浅色 | 深色 |
|---|---|---|
| `accent-50` | #eff6ff | rgb(24 132 252 / .12) |
| `accent-100` | #dbeafe | / .22 |
| `accent-200` | #bfdbfe | / .35 |
| `accent-300` | #93c5fd | / .50 |
| `accent-400` | #4d9bff | 同浅色 |
| `accent-500` | #1e86fc | 同浅色 |
| `accent-600` | #1680f3 | 同浅色（主按钮、焦点环） |
| `accent-700` | #126fd4 | 同浅色（主按钮悬停） |

一屏只有一个 `primary` 按钮。浅底上的强调字用 `accent-700`，深色模式下改 `dark:text-accent-400`。

### 3.3 状态色

| 状态 | 点/实心 `status-*` | 文字 `status-*-ink` 浅 / 深 | 徽章底 |
|---|---|---|---|
| online | #14c16f | #17784f / #29cb78 | `/10` |
| busy | #1e86fc | #1d4ed8 / #4d9bff | `/12` |
| attention | #f59312 | #95620a / #fb9500 | `/12` |
| offline | #959595 | #6b6b75 / #959595 | `sunken` |
| error | #e72e3b | #c32f37 / #ff6463 | `/10` |

旧色归档：amber/orange → `status-attention`，emerald/green → `status-online`。

### 3.4 遮罩 token（goxf 新增）

用于图片灯箱、浏览器卡片等「深色遮罩上的文字/底」，替代 `bg-black/xx`、`text-white/xx`。
两种主题取同一组值（遮罩总在媒体之上）。定义放在 `goxf-scale.css`，**数值以该文件为准**，以下为建议值：

| 类名 | 建议值 | 用途 |
|---|---|---|
| `bg-overlay` | rgb(0 0 0 / .5) | 普通遮罩、浮在图片上的按钮底 |
| `bg-overlay-strong` | rgb(0 0 0 / .72) | 灯箱背景、需要压暗的大面积 |
| `text-on-overlay` | #ffffff | 遮罩上的主文字/图标 |
| `text-on-overlay-muted` | rgb(255 255 255 / .7) | 遮罩上的说明文字 |

## 4. 阴影

| token | 用途 |
|---|---|
| `shadow-hairline` | 平铺面的 1px 描边感（无边框时） |
| `shadow-soft` | 卡片、输入框、设置分组卡（默认） |
| `shadow-card` | 可点的浮起卡片 |
| `shadow-float` | 分段控件滑块、悬浮小块 |
| `shadow-pop` | 菜单、下拉、弹出层 |
| `shadow-toast` | Toast |
| `shadow-dialog` | 弹窗 |

`shadow-xs/sm/2xs` 及自写阴影一律当 `shadow-soft`。深色模式下各阴影已在 globals.css 重定义，不要加 `dark:shadow-*`。

## 5. 组件

| 组件 | 什么时候用 | 规格 |
|---|---|---|
| `Button` | 一切文字操作 | `sm` h-7 / 12px / 图标 3.5；`md` h-9 / 14px / 图标 4；`lg` h-10 / 14px。变体：`primary`（每屏一个：发送/创建/保存）、`secondary`（默认，其余操作）、`ghost`（工具栏里的弱操作）、`danger`、`danger-confirm`（二次确认态） |
| `IconButton` | 只有图标的操作，必须给 `label` | `sm` size-7 / 图标 4；`md` size-8 / 图标 18px；`round` size-9 带边（侧栏头部） |
| `Field` + `TextInput` | 所有输入框 | 标签 14 medium，hint/error 12；输入框 h-9、rounded-lg、line-strong 边 |
| `SegmentedControl` | 2–4 个互斥选项、选项文字短 | `xs` 26px、`sm` 30px / 12px（设置行默认）、`md` 34px / 13px；超过 4 项或文字长用 `Select` |
| `SwitchPill` | 单个开/关 | `sm` 34×20、`md` 42×24 |
| `Select` | 选项多或文字长 | — |
| `Menu` / `MenuItem` | 「更多」菜单、右键菜单 | 面板 rounded-xl + shadow-pop；项 13px、rounded-md、图标 4；`hint` 12px |
| `Dialog` | 需要专注完成的流程、确认 | rounded-2xl + shadow-dialog；标题 15 semibold，描述 13 |
| `StatusDot` / `StatusBadge` | 连接/运行状态 | 点 size-2；徽章 h-5 胶囊、12px medium |
| `UnreadBadge` | 未读数 | 18px 胶囊、10px semibold（唯一 10px） |

**裸 `<button>`** 只允许三种：列表行（整行可点）、标签页、芯片（chip）。其余一律 `Button` / `IconButton`。
**裸 `<input>`** 一律换 `TextInput`（放在 `Field` 里）。

### 5.1 设置行（SettingsRow 模式）

```tsx
<div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-soft">
  <div className="flex items-center justify-between gap-4 px-4 py-3.5">
    <div className="min-w-0">
      <p className="text-[14px] font-medium text-ink">标题</p>
      <p className="text-[12px] text-ink-muted">一句说明</p>
    </div>
    {/* 右侧控件：SegmentedControl size="sm" / SwitchPill / Button size="sm" */}
  </div>
</div>
```

- 一组相关设置放在同一张卡里，行与行用 `divide-y divide-line` 分隔。
- 分区标题：17 semibold + 下方 13 `ink-secondary` 说明，与卡片间距 `gap-5`。
- 新功能不要用黄色高亮；需要提示时在标题后加一个小胶囊：
  `rounded-full bg-accent-50 px-2 h-5 text-[11px] font-medium text-accent-700 dark:text-accent-400`。

## 6. 图标

| 尺寸 | 用途 |
|---|---|
| `size-3` | 11–12px 文字旁 |
| `size-3.5` | `Button sm` 内、13px 文字旁 |
| `size-4` | 默认（菜单项、`Button md`、`IconButton sm`） |
| `size-[18px]` | `IconButton md / round` |
| `size-5` | 空状态、大图示 |

`size-4.5` → `size-4`。图标颜色跟随文字，不单独上色（强调用 `text-accent-600`）。

## 7. 内容宽度

两档：阅读 `max-w-[780px]`（设置、表单、文档），宽 `max-w-[860px]`（列表、表格、看板详情）。
其他宽度（820/720/680/640）不新写。

---

## 8. 上游合并

- **上游文件不改**。上游组件里的旧字号/圆角/颜色不去逐个替换，避免每次合并上游都冲突。
- 视觉统一靠 `src/renderer/src/styles/goxf-scale.css`：一份**不分层（unlayered）的覆盖样式**，
  把旧值（如 `text-[11.5px]`、`rounded-[11px]`、`bg-black/60`）映射到上面的档位和 token。
  因为不在 `@layer` 里，它稳定压过 Tailwind 工具类。
- 每次合并上游后运行：

  ```
  npm run design:check
  ```

  它列出上游新带进来、goxf-scale.css 还没映射的值。把它们按本规范的归档规则补进 goxf-scale.css，
  再跑一次直到列表为空，然后一起提交（`goxf(design): map upstream values`）。
- goxf 自己新写的文件（`goxf-*`、`GOXF:` 注释的代码）直接写档位值，不依赖覆盖。

## 9. 效果图流程

1. **效果图必须是真组件渲染后的截图**，不手画、不用设计工具拼、不用 HTML 仿写。
2. 工具：
   - 在 `src/renderer/src/mock/mocks/<名字>.tsx` 里用真实组件和真实类名拼出画面
     （设置行直接复制所在页面的结构），在 `src/renderer/src/mock/registry.ts` 登记。
   - 运行 `node scripts/goxf-mock.mjs <名字> [--out <目录>]`，得到
     `<目录>/<名字>-light.png` 和 `-dark.png`（默认目录 `work/mock/`，2x 清晰度）。
   - 入口是独立的 `src/renderer/mock.html` + `vite.mock.config.mts`，输出到 `dist/mock/`；
     应用和 web 构建都不会包含它。
   - 需要 playwright + chromium：仓库里没装时，脚本从 `/tmp/shot`（或 `$GOXF_PLAYWRIGHT_DIR`）加载：
     `cd /tmp/shot && npm i playwright && npx playwright install chromium`（Linux 另需 `npx playwright install-deps chromium`）。
   - 系统原生的东西（托盘菜单、系统通知、窗口标题栏）画不出来，在效果图下方用一行 12px `ink-muted` 文字说明。
3. **发图前自查**（逐条过）：
   - [ ] 字号都在 11/12/13/14/15/17/28 里（10 只给未读数）
   - [ ] 圆角都在 md/lg/xl/2xl/full 里
   - [ ] 颜色全是 token，没有 hex / white / black / 调色板色
   - [ ] 操作用 Button/IconButton，输入用 Field，选项用 SegmentedControl/Select/SwitchPill
   - [ ] 浅色、深色两张都看过：文字没被截断、没溢出、对比度够
   - [ ] 新增项没有用黄色高亮
