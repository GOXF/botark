# 全圆胶囊改动记录（自用版覆盖上游样式）

2026-11-25 用户要求：所有按钮和切换条统一为全圆胶囊（`rounded-full`），包括上游原有的。
合并上游时，下面这些位置如果冲突或被上游改回，按本表重新改成 `rounded-full`。

查找方法（在 `src/renderer/src` 下，跳过 `components/ui`）：手写 `<button>` 的 className 中出现
`rounded` / `rounded-md` / `rounded-lg` / `rounded-xl` / `rounded-2xl` / `rounded-[Npx]` 且不是行/卡片
（不含 `w-full` / `flex-col` / `text-left` / `justify-between`）的，都改成 `rounded-full`。
图片缩略图按钮（`Composer.tsx` 预览图）不改。

## 组件级

| 位置 | 原来 | 现在 |
|---|---|---|
| `components/ui/SegmentedControl.tsx` | 容器 `rounded-[11px]`，滑块和选项 `rounded-[9px]` | 新增 `pill` 属性，默认 `true`，三处都加 `rounded-full` |

## 逐处（行号以改动时为准）

| 位置 | 原来 | 现在 |
|---|---|---|
| `components/add-bot/MuseBatchImport.tsx:343` | rounded-md | rounded-full |
| `components/antigravity/AntigravityInfoSections.tsx:237` | rounded-md | rounded-full |
| `components/antigravity/AntigravityInfoSections.tsx:245` | rounded-md | rounded-full |
| `components/antigravity/AntigravityInfoSections.tsx:293` | rounded | rounded-full |
| `components/antigravity/AntigravityInfoSections.tsx:363` | rounded-md | rounded-full |
| `components/antigravity/AntigravityInfoSections.tsx:471` | rounded-md | rounded-full |
| `components/chat/Composer.tsx:325` | rounded-md | rounded-full |
| `components/chat/Composer.tsx:393` | rounded-md | rounded-full |
| `components/chat/MarkdownText.tsx:255` | rounded-md | rounded-full |
| `components/chat/MarkdownText.tsx:296` | rounded-md | rounded-full |
| `components/chat/MarkdownText.tsx:347` | rounded | rounded-full |
| `components/chat/MarkdownText.tsx:96` | rounded | rounded-full |
| `components/chat/MessageBubble.tsx:2418` | rounded-md | rounded-full |
| `components/chat/MessageBubble.tsx:2433` | rounded-md | rounded-full |
| `components/chat/MessageBubble.tsx:2442` | rounded-md | rounded-full |
| `components/chat/MessageBubble.tsx:2451` | rounded-md | rounded-full |
| `components/chat/MessageBubble.tsx:2479` | rounded | rounded-full |
| `components/chat/MessageBubble.tsx:68` | rounded | rounded-full |
| `components/chat/MessageBubble.tsx:85` | rounded | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:341` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:349` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:357` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:444` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:454` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:611` | rounded-md | rounded-full |
| `components/chat/NativeDocumentDialog.tsx:621` | rounded-md | rounded-full |
| `components/cue/CueInfoSections.tsx:1107` | rounded | rounded-full |
| `components/grok/GrokInfoSections.tsx:528` | rounded | rounded-full |
| `components/grok/GrokInfoSections.tsx:537` | rounded | rounded-full |
| `components/hermes/HermesInfoSections.tsx:359` | rounded | rounded-full |
| `components/info/AccountList.tsx:142` | rounded-md | rounded-full |
| `components/info/InfoPanel.tsx:203` | rounded-lg | rounded-full |
| `components/info/InfoPanel.tsx` 标签条容器+滑块 | rounded-[10px] / rounded-lg | rounded-full |
| `components/info/MemoryEditor.tsx:31` | rounded | rounded-full |
| `components/info/SecurityVaultCard.tsx:117` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:126` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:144` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:157` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:175` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:187` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:205` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:213` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:64` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:72` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:90` | rounded-lg | rounded-full |
| `components/info/SecurityVaultCard.tsx:99` | rounded-lg | rounded-full |
| `components/muse/FilesSection.tsx:194` | rounded | rounded-full |
| `components/onboarding/OnboardingGuide.tsx:249` | rounded-xl | rounded-full |
| `components/onboarding/OnboardingGuide.tsx:556` | rounded-xl | rounded-full |
| `components/settings/SettingsView.tsx:1295` | rounded | rounded-full |
| `components/settings/SettingsView.tsx:1994` | rounded-lg | rounded-full |
| `components/settings/SettingsView.tsx:2301` | rounded-lg | rounded-full |
| `components/settings/SettingsView.tsx:2437` | rounded | rounded-full |
| `components/sidebar/BotList.tsx:318` | rounded-lg | rounded-full |
| `components/sidebar/BotList.tsx:326` | rounded-lg | rounded-full |
| `components/workspace/WorkspaceTopBar.tsx:68` | rounded-[9px] | rounded-full |
| `rooms/RoomView.tsx:1057` | rounded-md | rounded-full |
| `rooms/RoomView.tsx:1066` | rounded-md | rounded-full |
| `rooms/RoomView.tsx:252` | rounded-md | rounded-full |
| `rooms/RoomView.tsx:443` | rounded-2xl | rounded-full |
| `rooms/WorkspaceTools.tsx:449` | rounded-lg | rounded-full |
| `rooms/WorkspaceTools.tsx:653` | rounded-lg | rounded-full |