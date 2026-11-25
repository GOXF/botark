# BotArk 交接单（2026-11-22 用户提供）

Fork: GOXF/botark；上游: qybaihe/botark（main = 0644b8c）

| 分支 | 状态 | 用途 |
|---|---|---|
| fix/hark-login-sync | 完成，vitest 235 通过，typecheck 通过，未真机验证 | 提 PR 的干净分支，4 个修复 |
| fix/hark-project-autotitle | 已并入上面 | 可删 |
| goxf/portable | 未完成、未测试 | 自用便携版 + 双更新提示，不进 PR |
| main | 等于上游 0644b8c | 没动 |

## 开 PR（用户自己点）
https://github.com/GOXF/botark/pull/new/fix/hark-login-sync ，base = qybaihe/botark main，Create draft pull request，标题和说明见 pr-description.md。

## 本地试用
git clone <GOXF/botark> && cd botark && git checkout fix/hark-login-sync && npm ci && npm run dev
真机检查：邮箱登录过 Turnstile、Google 登录、新建 Bot 粘贴导入后重启仍在线、网页端新建项目切回后出现、新建项目不报错。

## 便携版（goxf/portable）
已写：portable 打包配置、数据放 exe 同目录（goxfPortable.ts）、双更新逻辑（goxfUpdateLogic.ts / goxfUpdater.ts）、更新横幅（GoxfUpdateBanner.tsx）。
2026-11-22 已做：typecheck 通过、vitest 54 文件 251 测试通过、electron-vite build 通过；新增 goxfUpdateLogic.test.ts（16 测）、goxf-portable.yml（仅 GOXF/botark，v*-goxf.* tag → windows 出 portable exe → 发 fork release，--latest=false；手动触发只出 artifact）；release.yml 排除 v*-goxf.* tag 且 prepare 仅 qybaihe/botark 跑；pages.yml 仅 qybaihe/botark。
决定（2026-11-22）：main 保持镜像上游不改；自用版只在 goxf/portable，同步上游 = 把 main 合进 goxf/portable；给上游的 PR 从 main 开分支。
未做：Windows 真机验证便携数据目录和自替换更新。
发版：确认 package.json version + goxfBuild，打 tag v0.12.0-goxf.1 推上去。
手动出包（Windows）：npx electron-vite build && npx electron-builder --config electron-builder.config.cjs --win portable --publish never
触发词：「接着做 botark 便携版」→ 从 goxf/portable 接上。

## 进度（2026-11-22 19:01）
- Draft PR 已开：https://github.com/qybaihe/botark/pull/38
- Dot 跟进已推到 fix/hark-login-sync（22169f3）：查明 cancelDotLogin 只在未存 token 时清分区，非同一 bug；只补 onImported。PR 说明已更新。

## 遗留
- webContentsViewManager.ts 聊天视图仍改写 UA，登录后再遇验证改这里。
- 挂代理时出口 IP 与系统时区不一致未处理。

## 2026-11-22 20:45 zip 便携版
- 用户要的是"解压即用"的 zip（不要求单 exe），并且要一键替换式更新（参照其 harkhubgo 版，细节未知，按标准做法实现）。
- goxfPortable.ts：打包后 BotArk.exe 同目录有 BotArk-Data 文件夹 = zip 便携模式，数据放那里。
- 更新：zip 模式下载最新 v*-goxf.* release 的 *Portable*x64*.zip → 退出后 PowerShell 替换除 BotArk-Data 外的所有文件 → 重启，失败回滚（buildZipReplaceScript）。
- workflow 同时产出 exe 和 zip（输出目录是 release/ 不是 dist/，已修）。
- 已发给用户：BotArk-Portable-0.12.0-goxf.1-win-x64.zip（Linux 交叉打包、未签名、无 rcedit 图标）。
- 本地构建：npx electron-vite build && npx electron-builder --config electron-builder.config.cjs --win dir --x64 --publish never -c.directories.output=/tmp/ebout，再把 win-unpacked 拷成文件夹+BotArk-Data/README.txt 后 zip。
- 注意：别在仓库根目录运行 asar extract-file package.json（会覆盖 package.json）。
- 未验证：Windows 真机运行、zip 自更新脚本。
- 已推送：92ad443（zip 自更新代码）+ d56900d（workflow 产出 zip），远端与本地测试过的树一致。下一步：Windows 真机测；可考虑仿 Orca：有会话在跑时推迟替换。

## Orca (stablyai/orca @15407c88) 可借鉴点（2026-11-23 调研）
1. 会话 cookie 持久化：Electron 不把无过期时间的 session cookie 写盘，重启即登出。Orca 每 30s 把 session cookie 快照成 JSON，启动时先恢复再加载页面（src/main/browser/cookies/session-restore/）。BotArk 登录窗拿到的 cookie 若无 expiry 会同样丢失——优先排查。
2. 自动安装前检查：有在跑的会话就不自动装（updater-install-support.ts canProceedWithInstall / hasInProcessTerminalSessions）。zip 替换脚本前应检查是否有 bot 正在生成回复。
3. 发布就绪检查：提示更新前 HEAD 请求 release 资产，未上传完不提示（updater-release-readiness.ts）。我们 CI 先建 release 再传 zip，存在窗口期。
4. 更新节奏：每天检查一次，失败 1h 起指数退避到 6h；可选“延迟 N 天”，发布时间未知时视为不可装。
5. UA：Cloudflare 需要保留 Electron token，Google 拒绝带其他浏览器标识 —— 与 PR #38 的按 URL 切换 UA 结论一致。

## 2026-11-23 上游同步（已推送 goxf/portable 9f2832b；fork main 快进到上游 fb25d6b）
- 本地 goxf/portable：37e44cc（只留中英语言包 + perf.log）→ 7e823eb 合并 upstream fb25d6b（v0.12.1，#39 #40 #46 #47）→ chore SettingsView。
- 上游 #47 已吸收 PR #38 的大部分 Hark 修复，但 UA 用了它自己的方案；合并时 Hark 文件全取上游，删了我们的 harkUserAgent.ts / harkLogin.test.ts。PR #38 可能需关闭或缩小。
- 与上游差异仅 17 个文件，全是 goxf 专属（便携、更新、perf、workflow、builder 配置）。
- 推送：正在建 fine-grained PAT（仅 GOXF/botark，Contents+Workflows 写，30 天）以便 git push。
- zip：dist/BotArk-Portable-0.12.1-goxf.1-win-x64.zip 151MB，已发给用户。

- 推送方式：shell 加 credentials [{provider: github-goxf-push}] 直接 git push（PAT hark-botark-push，30 天，2026-12-23 到期）。不必再走网页上传。
- 上游 dfcc20a 明确写了 Hark (#38) 并 co-author GOXF：PR #38 已被吸收。

## 2026-11-23 Orca 借鉴已落地（goxf/portable 39de007，goxfBuild=2）
- F12 切换 DevTools（index.ts before-input-event）。
- goxfSessionCookies.ts + goxfSessionCookieLogic.ts(+test)：账号分区的会话 cookie 变更 5s 后用 safeStorage 加密存到 userData/goxf-session-cookies/<分区>.bin；启动时在主窗口前恢复。safeStorage 不可用就不存。
- GoxfUpdateBanner：有 bot 在回复（store.typing）时禁用“更新并重启”。
- goxfUpdateLogic：只认 state=uploaded 的资产；nextCheckDelayMs：成功 24h，失败 1h→2h→4h→6h。
- 未做：“发布 N 天后再装”延迟设置（单人自用，暂不需要）。
- 测试：typecheck 过，vitest 70 文件/340 过。未在 Windows 真机验证。

## 2026-11-23 12:30 goxf.3（goxf/portable fd1d78f）
- Hark 实时状态：observeProject 的会话流把 narration/activeActivity（HarkConversationSyncState.liveStatus）随 projectHistory 一起发给前端，驱动 TypingIndicator；pollReply 改为优先用会话级 narration。
- 输入草稿：goxfComposerDrafts.ts 按 bot 缓存未发出的文字和附件（内存里，重启后不保留），发送后清空。
- 右侧「项目」加刷新按钮（派发 bothub:hark-projects 事件）。
- 参考仓库 GOXF/hark-hub-go（私有，PAT 已加读写）：它直接套 Hark 网页，状态和草稿都是网页原生的，没有可直接照搬的代码。
- 未在 Windows 真机验证。

## goxf.4（2026-11-23 13:12 推送，tag v0.12.1-goxf.4，goxf/portable 19d5887）
- 增量自更新：CI 上传 zip + manifest-*.json（每文件 sha256）+ patch-*.zip（resources/）；resources 外文件全对上才走补丁，只换哈希不同的文件，校验失败不动，失败回滚；日志 BotArk-Data/update.log，update-pending.json 失败横幅。
- 更新通道：正式=tag v*-goxf.N；测试=每次推 goxf/portable 发预发布 v<ver>-goxf.dev.<sha7>，保留 5 个；设置 BotArk-Data/goxf-update.json，默认正式。
- Hark：回复后仍持续监听到空闲（10s）或 30 分钟；项目列表 工作中/完成；侧边栏 工作中·N 个项目、完成黄点、流式回复未读角标。/conversations/status 内层结构未确认，F12 有 `[hark] /conversations/status sample`。
- Muse：activity_text 非空即显示（Waiting for cooldown · N subagents）。浏览器卡片未做：缺真实数据，等用户用 BOTARK_MUSE_CAPTURE=C:\temp\muse.ndjson 抓包。
- 测试 75 文件 / 368 用例通过。PowerShell 换文件脚本、CI dev 发布与清理、真机均未验证。
- 工作树：/workspace/work/botark-{delta,status,muse}（已合并，可删）。

## goxf.5 自更新修复（2026-11-23 14:05 已提交 061fec7，tag v0.13.0-goxf.5 已推）
- 上游 v0.13.0 仅版本号；fork main 已快进 0dc49b8；goxf/portable 合并为 4a8ce2b（0.13.0, goxfBuild 4）已推。
- 用户卡在 0.12.1-goxf.1：更新后不重启、版本不变。疑因：退出后 Expand-Archive 慢无提示→用户重开旧版占锁→回滚。
- 工作树 /workspace/work/botark-upfix（goxf/w-upfix）：goxfUpdateLogic.ts、goxfUpdater.ts 已改（app 内 tar.exe 解压、杀 app 目录残留进程、update-in-progress.lock、强制退出、update.log）。
- 剩余：goxfUpdate.ts 加 portable-extracting 事件；GoxfUpdateBanner 解压中卡片；goxfSessionCookies 导出 async flushSessionCookies；index.ts 在 requestSingleInstanceLock 前调 exitIfUpdating；goxfBuild→5；更新测试；typecheck+vitest；提交→合并 goxf/portable→打 tag v0.13.0-goxf.5。
- 用户需手动下载一次 goxf.5 覆盖。
- 14:05 完成：剩余项全部做完，typecheck 过，vitest 371 全过（mcp hub 偶发超时，单跑通过）。合并进 goxf/portable 061fec7 并推送 tag。未在 Windows 实测。

## 14:40 进展
- goxf.6（1f413cb）：Hark 新建项目可留空名，Hark autoTitle。
- bee4269：侧边栏双击 bot 名/分组名重命名。
- 1ea4805：CI 快速通道（scripts/goxf-fast.mts）：分支推送且依赖/lock/electron-builder 配置/build/ 未变 → 只 electron-vite build + 重打 app.asar，发只含 manifest+patch 的 dev 预发布，实测 49 秒；否则全量。客户端测试通道接受只有补丁的 dev 版，补丁不适用时回退到最新全量 zip。未在 Windows 实测补丁应用。
- 已删除 worktree botark-upfix、botark-fast。
- 15:06 同步上游 v0.13.1（Muse Sentinel 审批修复），goxf/portable 6da9c2b（0.13.1, goxfBuild 7），fork main=66c50c2。
- ae8586a：Hark「新建」一键创建空名项目并打开（autoTitle），去掉输入框。项目重命名未做（需查 Hark 改名接口）。
- 15:12 47a06ae：新建改为草稿（activeSessionId 'hark:draft'，首条消息时 createConversation 空名 autoTitle）。
- 15:19 27bfdbc：Hark 会话续期（get-session needsRefresh→POST；/auth 外 401 先续期再重试；在线账号每 20 分钟续期）；用户图文消息保留图片。未实测。
- 15:20 a087c27：侧栏时间下小圆点（蓝=未读，橙=任务完成）。
- 15:30 000a6f3：工具卡片保持一张一张（用户要求不合并），每张下面显示在干什么（input.task/description/query… → detail）。未实测 Hark 是否在 tool_add 里给 input.task。
- 15:38 dc0f6ab：项目删除按钮（DELETE /conversations/:id，探测返回 401 非 404 说明路由存在；带确认框；归档列表也可删）。未实测。
- 15:38 626ee59：未读数字圆移到时间下方并居中（替代右侧徽标），完成=橙点。用户已在 goxf.7，日常走测试通道。
- 15:50 测试通道每 10 分钟检查更新（正式仍每天；启动 8 秒后查一次；切换通道立即查）。
- 15:58 设置页账号列表宫格模式（默认，最宽 1680px，卡片 ≥380px 自适应列数）+ 宫格/列表切换（localStorage goxf.accountLayout）。
- 16:00 adbd97b：宫格模式下整个设置内容区铺满（max-w-none），列表模式保留 820px。
- 16:08 bed42d9：更新下载改用 electron net.fetch（走系统代理，此前 Node fetch 直连 GitHub 很慢）；update.log 记录下载文件和 MB；更新提示改为右下角小胶囊（测试版 xxxx · 更新）。dev 补丁约 6.0MB。
- 16:15 11fa765：下载中可「取消」（AbortController，删半成品，恢复更新提示）；点「更新」前先重新检查，总是装最新版。未做暂停/续传。
- 16:12 额度重置时间：给了效果图（A 进度条下小字 / B 标题旁+快用完变橙），等用户选；Hark 今日额度按账号固定时刻 24h 重置、周期按订阅日；需确认 /billing/summary 是否含 resets 字段（可能要 F12 样本）；拟加每 5 分钟自动刷新。
- 16:40 018d4e9：额度已用/剩余切换（同格式只换色，剩余按 >50 绿/20–50 橙/<20 红）、重置时刻+倒计时（字段名猜测，无则不显示）、5 分钟自动刷新；上游提示关闭后记住。已发 dev。用户仍显示上游提示 → 说明还在 0.13.0（goxf.7）。
- 16:42 发现：goxf.7 与 6da9c2b 的 BotArk.exe 哈希不同（大概只是版本戳），增量规划因此拒绝补丁→退回下 155MB 完整包＝更新慢的真正原因。待办：增量规划忽略 BotArk.exe 版本戳差异或 CI 固定 exe。用户本次手动覆盖 018d4e9 补丁的 resources。
- 17:08 设置账号宫格留白：给了 grid-mock2（A 5×2 卡片/B 两列紧凑横条悬停出操作，我倾向 B），等用户选+开工。

## 2026-11-23 17:20
- e800986 推送：历史重载后用户图片靠右、在文字上方。
- Hark 重启离线排查完成（work/hark-offline-diagnosis-2026-11-23.md）；7 项修复方案待用户「开工」。疑似 24h 不续期会话，长期需自动重登。
- 账号卡片网格：Untitled UI 效果图 /workspace/work/mock/untitled-mock.png 待确认（右上开关要不要）。
- a8e211c：中途加入项目时快照里对象形式的 activeActivity/narration 被丢 → 状态行缺失，已修。
- 3255c99：离线修复（get-session 为准、20 分钟全账号重查+广播、去 POST 续期、.hark.com、退出 flush、取消登录不误删、调试日志）。未真机验证。用户说会话寿命很长，不做自动重登。
- 已通知用户 dev.3255c99 可更新（含 e800986、a8e211c）。
- Hark session_token 为持久 Cookie，Domain .hark.com，有效期约 30 天（用户 17:54 截图确认）；带 better-auth multi-session cookies。24h 假设已排除。
- 4fa5686：合并上游 v0.13.2（Muse session.start/网关自愈/rooms），version 0.13.2 goxfBuild 7；fork main 已快进。mcp hub.test 并发下偶发失败，单跑通过。
- 更新提示统一成上游底部居中 toast：效果图 /workspace/work/mock/toast-mock.png，待「开工」。字体备份 /workspace/work/mock/NotoSansSC.ttf（/tmp 会丢）。
- 用户 18:00：不用上游 toast，保留我们自己的大卡片样式；把便携版更新提示统一成「上游有更新」大卡片（效果图 /workspace/work/mock/big-mock.png），待「开工」。
- 07a6bf0：便携版更新提示统一成大卡片（Notice 组件）。已通知用户更新测试版 07a6bf0（含 e800986、a8e211c、3255c99、4fa5686）。仍待：账号卡片网格 Untitled 效果图确认。
- 18:25 用户自动更新失败：4fa5686 为完整构建（package-lock 变），07a6bf0 补丁基于新运行时 → 回退整包 4fa5686 → 替换失败，仍 0.13.1。已给手动整包链接，等 update.log 查整包替换失败原因（未解决 bug）。
- 18:28 update.log 诊断：16:19 与 18:21 两次整包更新都停在 "swap script started"+"quitting"，%TEMP% 里的 PS 脚本一行日志都没写（连 waiting for app pid 都没有）→ 脚本没跑起来/被杀（疑似杀软拦隐藏 powershell -ExecutionPolicy Bypass）。非文件占用。拟修：去掉 PowerShell，由新版 BotArk.exe 带 --goxf-finish-update 参数自己等旧 pid、替换、重启；并记录 spawn error/早退。约 40 分钟，等用户「开工」+ 是否装 360/火绒。
- 18:55 f3d5961：zip 自更新改为 Node 模式助手（goxfUpdateHelper.ts，ELECTRON_RUN_AS_NODE；整包用新暂存 exe、增量用当前 exe；写 ready 握手，助手起不来 app 不退出；下次启动清理 stage/backup）；删除 PS zip/delta 脚本（exe 单文件模式仍用 PS）。更新提示 portal 到 body 顶层 z，Muse 等原生网页视图自动让位（lib/noticeRect.ts）。4c835ad 发正式 v0.13.2-goxf.8 整包（用户需手动装一次）。6a0d965 聊天气泡右键菜单（复用 Menu，虚拟锚点）。均未 Windows 实测。
- 待开工：代理改造（proxy-mock2.png：代理池可勾平台、每代理账号上限默认不限、手动绑定不受限；账号侧栏 真直连/跟随系统/代理；现 direct 实为 mode system）；Hark 邀请好友（invite-mock.png，用 /api/invite 字段 counted/friendsPerReward/claims/landedReward，参考 hark-hub-go internal/invite）；设计审计 38 条 work/design-audit-2026-11-23.md，问用户是否先修 Top10。
- 18:58 邀请改版：官网邀请码 NKW9NC ≠ app.hark.com /api/invite 的 3MXZGT（那是兑换侧的码）。邀请数据改走 GET https://hark.com/api/invite（参考 hark-hub-go internal/invite）；「兑换」单独一节保留。效果图 invite-mock.png 已发，等「开工」。
- 19:03 已推 goxf/portable 68e7ae3（52c6571 设计规范 Top10 + 邀请进度/链接/有效期 lib/harkInvite.ts + 设置页宽度只在账号页撑宽），CI 成功。用户已在 0.13.2（goxf.8）。perf.log 正常。
- 代理改造进行中：worktree /workspace/work/botark-proxy 分支 goxf/proxy（子代理 proxy-rework），完成后合并进 goxf/portable 再推。
- 待用户：网格右上开关去掉还是做成启用/暂停账号；/billing/summary 用浏览器 Hark 网页 F12 取；Muse 抓包用 set BOTARK_MUSE_CAPTURE。
- 19:12 已推 goxf/portable dcab0e4：8709cd6 更新暂停/续传/解压取消/×隐藏；6d87f47 解压 5 分钟超时+日志、额度「已用完」+赠送到期行；合并 goxf/proxy cbd4890（全平台网络代理三选一、池按平台自动分配、上限默认不限、删池代理自动解绑、启动清孤儿绑定）。用户需手动把 Muse 号 70.39.201.51 改跟随系统。
- 进行中：hark-reply-quote 子代理（Hark 回复显示被回复消息，字段名未验证，会打 '[hark] message keys:' 日志）。
- 待用户：是否加「后台 10 分钟未看网页自动卸载」省内存；update.log（解压卡住）。
- 19:13 已推 8ccedff Hark 回复引用（字段名未验证，看 '[hark] message keys:' 日志补 REPLY_KEYS）。
- 19:17 87c697a：delta 卡在解压后=Electron fs 把 staged app.asar 当目录，sha256 挂起；改用 original-fs（src/main/fsNoAsar.ts），helper 加 ELECTRON_NO_ASAR。muse capture 启动即建文件。打 tag v0.13.2-goxf.9 整包，用户需手动下载覆盖一次（旧版自更新代码本身有 bug）。
- 19:28 推 f5ef033 goxf(perf)：手机同步未开时不建快照+图片缓存 48MB 上限；localStorage 每秒最多写一次；闲置 10 分钟且不忙的 bot 裁到 50 条，打开时重载。Dot/无会话ID 不裁；当前 bot 无虚拟滚动。未真机测。
- 20:31 tag 构建因 goxfBuild 未改失败；bb42cf8 改 goxfBuild 9 重打 v0.13.2-goxf.9（含 f5ef033）。定时任务 43a5e74c 20:45 起查 zip。规则：打正式 tag 前必须同步改 package.json goxfBuild。
- 20:40 任务面板效果图 work/mock/tasks-mock.png（参考 Xircth/VibeX 看板：进行中/等你处理/已完成，卡片=会话，含需求+状态+停止/批准/重试），等「开工」。设计审查实际剩 21 项（清单已发用户），等用户选。perf.log 提醒任务 4b70f8b1 改到 2026-11-24 18:00。
- 20:42 任务面板效果图 v2 基于用户真实截图：work/mock/tasks-mock2.png（tasks2.py），侧栏「工作区」上方加「任务」行，中间三列看板，右栏收起。等「开工」。
- 20:45 任务面板 v3：tasks-mock3.png，保留右栏，StatusBadge/Button sm/SegmentedControl xs，等「开工」。
- 20:55 任务面板 v4（用户否了独立看板页，要参考 Orca/T3 Code）：tasks-mock4.png（tasks4.py），只改侧栏——顶部「需要你」分组带批准/重试，工作中/刚完成的 bot 第二行显示状态+当前步骤，聊天窗不动。等「开工」。
- 20:55 设计审计修复已推 goxf/portable bb42cf8..f5e8789（13 提交）：d1afd2c #14#15 UnreadBadge/StatusDot；01d9652 #3#5#11 Notice×用IconButton、描述 caption+2行截断、更新通道行加载时禁用占位；77ee1f1 #27 群聊拖放提示改 toast 外观（仍左下）；8fa7808 #28 RoomInspector 原生 select→Select；8e56c11 #29 AddBot 批量导入离开确认改 App 内 Dialog；c3b2558 #30 聊天主按钮→Button primary sm（6 处；选项 chip 未改；授权链接 <a> 仅对齐 h-7 样式）；9d9a480 #26 工具调用两列；f2f8113 #25 重载用户图片 max-w-64；486871e #31#32 共享 ImageLightbox(portal, shadow-dialog)+ImageOverlayButton；e598505 #33；7f84cf7 #34；e5d7bbd #19；f5e8789 #23#35#36。#2 早已修（Notice error 属性）。跳过 #8 剩余（悬停已在 52c6571 修好；剩余未分层规则是故意压过 li 的 items-center 和外层卡片 utilities，挪进 @layer components 会把宫格和 #6 弄坏，改 Tailwind 变体需 6 列表+6 外层大改且无法本地目测）。#4/#38 按要求未动。typecheck 过，vitest 430/433（hub.test.ts 全量下超时，单跑 7/7 过）。均未 Windows 实测。
- 21:12 修 goxf.0 显示 bug（87c697a 改 original-fs 后读不到 asar 内 package.json → goxfBuild 0，更新判断也错）：6cc379a 用 node:fs 读，已推测试通道。审计第二批 f5e8789 已推。
- 21:15 用户确认 #4（更新卡片置顶最高层级）按其要求保留，审计清单划掉。

## 搁置待办（用户说需要时再做）
- #38 字号收敛（2026-11-23 搁置）：渲染层约 1000 处硬编码 text-[Npx]，12 种小字号（9–14.5px）；方案收敛为 11/12/13/14 四档 token。改动面最大、优先级最低。详见 work/design-audit-2026-11-23.md #38。
- 21:20 Muse 额度显示「用量不可用」：QuotaSection 经 cleanSidebarError 静默隐藏兼容类错误（action 轮换/未登录 hatch_sess）。提议：灰字显示原因+原始错误写 perf.log（~15 分钟），等用户回复是否出效果图。上游已发 v0.14.0（a3c3ce7），未合。
- 21:23 Muse 额度原因提示效果图 work/mock/musequota-crop.png（musequota.py）：A 灰字「额度接口已变」，B「网页登录已失效」+重新登录；等「开工」。已请用户从 muse.ai/settings 抓 Next-Action 值+响应。
- 21:35 91878a1 Muse 额度原因提示（errorCode: action_not_found/parse→「额度接口已变」，signed_out→「网页登录已失效」+重新登录 Button ghost sm 调 openMuseLogin；perf.log 记 `muse-quota <id> <code>: msg`）。
- 21:35 62f0092 合上游 v0.14.0（version 0.14.0，goxfBuild 仍 9）：冲突 package.json/harkIpc/harkStream.test/ipc.ts，projectHistory 同时带 live 和 browserPreview。typecheck ok，vitest 444/444。已推，CI 测试通道构建中。
- 结论：侧栏「在线」需要 partition 里有 hatch_sess（museSessionManager ~325），所以 cookie 没丢；若出现「网页登录已失效」是 muse.ai 拒绝了该 cookie（401/403）。更可能是 Server Action id 轮换。
- 21:39 dev 版 v0.14.0-goxf.dev.62f0092 已发布（21:37，zip 155MB + patch 6MB）；不需整包，应用内补丁更新即可。
- 21:48 96857a8 Muse 额度 Server Action 新 id 40e0249eeae158685b6a8d0c3b203f53dd4f2c7d63（用户抓包，POST /），postAction 先试 / 且 200 非额度内容时继续试 /settings。
- 21:52 任务面板参考图已发：Orca agent-statuses（onorca.dev）、T3 Code 新侧栏（Theo X 2079892861689254129）、Vibex（linux.do/t/topic/3150023，用户说的 VibeX 是这个 GPUI 多智能体工作台）。v4 接近 T3 Code 做法，仍等用户定方向+「开工」。
- 21:57 用户发 Vibex 截图（files/uploads/image-170ea6d01844.png）：顶部 看板/工作区/协作空间 切换，看板模式左侧会话列表按状态分组带计数，聊天不动。提议 v5：顶部「会话/任务」切换，任务模式分 等你处理/进行中/已完成；等用户同意出图（约 20 分钟）。
- 21:59 用户：Vibex 协作空间比我们群组方式好多了，要群组也能多组干活。我方差异：CollabRoom 单群聊轮流发言；Vibex Task Team=总管拆派、成员各开子会话并行、侧栏组下挂子任务状态、中间分屏。提议群组改「任务组」（组内并行+多组同时跑），等用户确认范围后出效果图（约 30 分钟），「开工」才写代码。

## 交接 2026-11-23 22:00（额度剩 10%，16 小时后重置）
- 用户确认「任务组」范围：多个群组同时干活 + 群组内 bot 同时跑（并行，不再轮流发言）。
- 下一步：出效果图 v5（约 30 分钟），基于用户最新截图，参考 Vibex Task Team（/tmp/g.jpg 已失效时重下 https://cdn3.ldstatic.com/original/4X/5/7/8/5784c3982f625d103e1839dd1cef29104b2fc988.jpeg）：
  1. 侧栏群组可展开，下挂每个成员子任务 + 状态（进行中/等你/完成）+ 用时，组标题带「N 运行中」。
  2. 中间 群聊 / 分屏 切换，分屏同时看多个成员。
  3. 顶部「会话 / 任务」切换（Vibex 看板式按状态分组）。
- 代码落点：src/renderer/src/rooms/（model.ts CollabRoom: mode manual|auto, cursor 顺序轮流 → 改并发派发）、RoomView.tsx、roomStore.ts、sidebar/BotList.tsx。等「开工」才写。
- 继续命令：cd /workspace/work/botark && git checkout goxf/portable && git pull && python3 /workspace/work/mock/tasks4.py（以 v4 脚本为底改 v5）

## 2026-11-23 22:30（新账号接手）
- 新账号项目工作区：/workspace/projects/611143f9-c3e5-4009-8c13-e0450fd350a0/work/botark；效果图在同级 work/mock/（v5.py 生成，字体 NotoSansSC*.otf）。
- 任务组 v5 效果图已出：v5-A-split.png（会话模式：侧栏组下挂成员子任务+状态+用时，中间分屏 3 成员，右栏派发方式 总管拆分/全员同题/手动@、同时运行不限）；v5-B-tasks.png（任务模式：等你处理/进行中/已完成，群聊内并行进度条）。等用户「开工」。
- 本账号尚未保存 GitHub PAT，暂不能推送；Muse 相关事项本账号不处理。
- 22:35 用户否了「任务组」：要的是每个 bot / 每个群聊各自正在进行的任务，按状态区分。v5 作废。出 v6（work/mock/v6.py）：A 任务视图（顶部 会话/任务 切换，bot 与群聊混排，分区 等你处理/进行中/刚完成/空闲折叠，卡片=谁·任务·当前步骤·用时）；B 会话视图内嵌状态（状态筛选 chip、头像状态点、第二行换成当前步骤）。等用户选 A/B/都要 +「开工」。
- 22:40 v7（work/mock/v7.py）：用户要顶部中间 bot 胶囊左右各加一个入口：左「任务」、中=会话（当前 bot 胶囊+状态小字）、右「协作」，点哪个进哪个页面；侧栏去掉会话/任务切换，保留状态点+筛选。任务页=三列看板 等你处理/进行中/刚完成（bot+群聊混排，点卡片回该 bot 会话）；协作页=群聊列表带状态。等「开工」。
- 22:45 用户：图片预览缺左右切换。已做（本地提交，未推送——本账号没 PAT）：ImageLightbox 打开时收集页面里带 data-lightbox 的缩略图（MessageBubble 平台图片/用户附件、MarkdownText 图片），两侧圆按钮 + ←/→ 键循环切换，文件名旁显示 n / N，切换时缩放复位；非初始图的保存用 a[download]。typecheck:web 过，未 Windows 实测。
- 22:50 v8（work/mock/v8.py）用户定稿方向：顶部 任务 · [当前胶囊] · 协作（「群聊」改名「协作」）。会话页侧栏只有 bot，不出现群组、不显示任务状态；协作页侧栏只有群组，展开=组内各成员会话；任务页=正在工作（进行中+等你）的会话，中间 2×2 并排集中显示各自的工作（任务、最近几步、当前一步、用时、补一句、打开）。等「开工」。v6/v7 的侧栏状态点/筛选作废。
- 22:40 新 bug（用户截图）：BotArk 原生 Hark 对话丢内容——浏览器实时卡片（GitHub 2FA 画面 +「需要采取行动」）和「输入你的 Github 验证码」表单按钮在原生聊天里都不显示，只剩「等待任务完成…」，只有「项目」网页视图里看得到。之前 request_secret 表单渲染差也是同一类。修法方向：HarkAdapter/harkStream 识别这类卡片事件，原生里至少渲染成一张「需要你处理 → 打开网页视图」卡片。先出示意图，等「开工」。
- 22:45 PAT 已建（hark-botark-push-2，到 2026-12-23，仅 GOXF/botark + hark-hub-go，Contents/Workflows 读写）。已推送 goxf/portable 到 9c91e49，测试版构建 run 45196785605 进行中（含图片预览左右切换）。
- 22:55 本地已合并上游 v0.14.1（冲突：package.json、HarkAdapter.ts/test — 保留草稿项目 + 上游 Stop/abort 检查），version 0.14.1、goxfBuild 10；typecheck + 455 测试通过。未推送、未打 tag，等用户确认后打 v0.14.1-goxf.10 完整包。用户机器显示 0.13.2-goxf.0（自更新没生效），要求直接给完整包。
- 23:00 v0.14.1-goxf.10 完整包已发布。Hark 原生丢卡片：远程浏览器条（HarkBrowserCard，上游 #55）goxf.10 里已有但默认折叠；验证码/表单没做——数据已在 snapshot.asks（harkClient extractAsks，右栏 HarkInfoSections 在用）。示意图 work/mock/v9-hark-ask.png：浏览器条等你时自动展开+橙框；聊天里「需要你」卡（验证码原生填，登录/卡片/密钥→在网页里填）；侧栏「需要你：…」+橙点；胶囊=等你处理。等「开工」，约 1.5 小时，走测试通道增量。待查：提交验证码的 Hark RPC（需在网页里抓一次）。
- 23:20 已做（测试通道增量）：① v9 Hark「需要你」卡：shared/harkAsks.ts（分类 code/credential/confirm）、projectHistory 带 asks、HarkAskCard.tsx（验证码/允许拒绝走 POST /messages/tool-response，未在真机验证；失败提示「在网页里填」）、浏览器条等你时自动展开+橙框+5 秒刷新、HarkProjects 把 activity 设为「需要你：…」。② 文件下载进度：main/goxfDownload.ts 流式下载到「下载」目录（net.fetch 走系统代理），卡片显示 %·MB/MB+进度条、取消、打开文件夹。typecheck + 458 测试通过。待用户 Windows 实测：验证码提交是否被 Hark 接受。

## 2026-11-24 11:10 已做（测试通道增量）
- 「处理中…」不变：发送尾流和项目流两路写同一状态行，项目流读数为空时把进度文字覆盖成 null。HarkProjects 空读数保留上一句；liveStatus/livePhrase 无旁白时用正在运行工具生成「正在用浏览器：…」（harkRunningToolLine）。未真机验证；若仍只显示处理中，需抓 /sync/conversation 帧看旁白字段名。
- 输入框待发送图片缩略图可点开 ImageLightbox 预览（已发出的图原本就能点）。
- 11:15 追加：回合结束后 Hark 仍在等后台任务（官网「正在等待构建完成」），原生不显示。liveStatus 对最后一条回复里仍 running 的工具 / 活动面板也判忙并出文字；narration_*/activity_* 改名操作兼容；便携版写 BotArk-Data/hark-frames.log（1 MB 轮转）记录帧字段。若仍不显示，让用户发 hark-frames.log。
- 11:25 追加：状态行/侧栏/气泡不再用 thought（官网不显示的英文内部思考，如 Let me find the logs…）。官网旁白「正在查询数据库记录。」字段仍未对上，等用户发 hark-frames.log。
- 11:30 根因（hark-frames.log）：narration 是对象 {line, lineKey, live, visible, working, answered, since, messageId}，旧代码只认 label/text，所以一直为空。已改 harkActivityLabel 读 line、answered/working:false 视为结束，working:true 判忙；消息级 narration 同样按对象读。
- 11:30 用户决定：旁白不翻译，照模型原文显示（不做 lineKey 映射/翻译服务）。

## 2026-11-24 12:40 进度
- Hark 登录卡原生填写：已抓到接口 POST https://hark.com/api/secrets → POST /api/messages/tool-response；还等用户发两条的 Payload + secrets 的 Response 截图（密码打码），拿到后约 1h 做原生表单。
- v10 效果图（work/mock/v10-A-card.png / v10-B-full.png）：顶部浏览器条改成对话内卡片（当前步骤/计划/放大/缩小/关闭/需要采取行动），放大=全屏，新增计划常驻右侧、截图记录、保存截图、在网页里接管。等「开工」（约 1.5h）。计划步骤数据源未核实，没有就显示旁白记录。
- 12:55 `87f6453` 登录卡原生填写：HarkAskView.login {scope,label,fields}（harkAsks.loginSpec；卡片/密钥/token 仍去网页；无 scope/domain 时也去网页）；HarkAskCard 表单 账号+密码(眼睛) → POST /secrets {type:'login',scope,label,conversationId,fields} → 取 id/secretId → POST /messages/tool-response value=JSON {secretId}。BotArk 不存密码。
- 13:05 `c358114` v10 开工完成：HarkBrowserCard 重写，放到对话末尾（MessageList 之后、需要你卡之前），实时/网址/时间、截图点开全屏、当前步骤胶囊、计划（=旁白记录，Hark 流里没有计划步骤）、全屏/收起/关闭、等你时「需要采取行动」；全屏（portal, Esc）带计划、截图记录(最多 24 张)回看、保存截图、在网页里接管。测试 462 过。等真机反馈。
- 13:20 `b21f73a` 更新卡：机器人回复中点「回复完更新」=排队自动装；手动检查更新清除 × 掉的卡。用户当时因 Hark 回复中按钮灰 + 卡被 × 而没更新到 c358114。
- 13:35 `d419223` 更新提示：查到新版一律「发现新版本」，手动检查弹 toast；能否马上装用橙字 note 另起一行（用户要求两者分开提示）。
- 14:35 `d0c9d52` 浏览器卡对齐消息列、结束收起/无图隐藏、failed 红叉。
- 14:40 `84395e7` 侧栏「已休眠」标记（trimmedBots，闲置 10 分钟已裁记录）。闲置卸载早已有（f5ef033 + 内嵌网页 90 秒休眠），用户答「要」即此。账号网格右上开关只在旧效果图里，删掉此项。
- 用户看了 v8 仍不满意，参考 t3code / Orca / VibeX。已提议 v11：主界面=左侧账号→会话树+状态点、中间 1/2/2×2 分屏、右侧浏览器/文件；看板（VibeX 式）做第二页。等用户确认再画（约 40 分钟）。
- 14:55 v11 效果图已发（work/mock/v11.py → v11-A-workbench.png 工作台：账号→会话树、1/2/2×2 分屏、右栏浏览器/文件/额度；v11-B-board.png 看板五列）。等「开工」，代码约 3–4 小时。
- 15:00 用户要顶部「看板 · 会话 · 协作」三入口。v12 效果图已发（work/mock/v12.py → v12-1-board / v12-2-sessions / v12-3-collab）：看板无侧栏五列含群组；会话页侧栏只有会话+布局 1/2/2×2+右栏浏览器；协作页侧栏群组展开成员、右栏成员/分工/文件。默认打开看板（待用户确认）。等「开工」，约 4 小时。v11 作废。
- 15:05 宫格操作提议（待用户确认）：t3code 式固定布局 1/2/2×2 最多 4 格，点侧栏进当前格；加 Orca 式拖到格子边缘新开、Ctrl+\ 分屏、Ctrl+1~4 切格；暂不做格内标签；右栏唯一跟当前格；布局与内容重启保留。
- 15:10 网上反馈调研已发（t3code #27874/#6746/PR#40923，Orca #8377/#25461，Reddit/HN）。结论：细看≤4 格、更多用看板；侧栏顺序固定；状态醒目+后台通知；切换不丢会话/滚动；格内不嵌标签；可弹出独立窗口。v12 待补：侧栏固定顺序、弹出窗口、后台通知。仍等「开工」。
- 14:53 用户认可人性化做法 7 条 + v12 补项，但分屏改为 Orca 式自由切分（不设 4 格上限）：拖到边缘切分、Ctrl+\ 右分、Ctrl+Shift+\ 下分、可嵌套、分隔条可拖。我建议加最小格宽（约 360px）防止字太小。待用户选：先重画 v12-2 会话页 mock（约 20 分钟）还是直接「开工」（估算由 4h 增至约 5.5h）。
- 15:00 用户定：最小格宽 360px；先出效果图。v13（work/mock/v13.py → v13-1-free-split.png 右栏收起三列嵌套、v13-2-drag-split.png 拖到边缘切分+360px 拒绝提示）已发，顶栏「布局 1/2/2×2」换成 向右分/向下分/均分。等「开工」（约 5.5h）。

## 2026-11-24 15:15 v12/v13 开工（分支 goxf/v12-workspace，草稿 PR → goxf/portable）
- 用户 15:00「开工」；15:10 要求进行中的工作也进 PR/Issue，方便额度不够时交接。PAT 无 PR 权限（403），PR 和 Issue 用浏览器（GitHub 已存登录）创建。
- 已完成（fd6b66e）：lib/paneTree.ts(+test) 二叉切分树、最小 360×240、ratio 边界、均分、拖放区；store/paneStore.ts（view/startView/tree/focus/stash 最大化/scroll，持久化 botark-panes-v1）；components/workspace/{PaneGrid,WorkspaceTopBar,BoardView}.tsx；services/workspaceSync.ts（聚焦格↔selectedBotId、删 bot 清格、离屏回复/完成/需要你 系统通知、Hark ask 计数）；ChatArea 加 botId/focused；MessageList 滚动位置还原；Ctrl+\ / Ctrl+Shift+\；设置「启动时打开」；Sidebar 按页过滤；harkWork 可见=所有格。
- 限制：一个格 = 一个 bot（同一 Hark 账号的两个项目不能同时开两格，因为消息按 bot 存）。
- 待做：侧栏 Hark 项目挂在账号下、格号角标；真机测试；合并到 goxf/portable 出测试包。
- 下一版（Issue）：格内标签页、弹出窗口、手机分屏、任务流水线（基于管理员调度）、群组之间交接（定稿交给另一个群）。
- 15:25 网页内验证（playwright + dist/web，假数据）：看板五列、单窗、Ctrl+\ / Ctrl+Shift+\ 切分、360px 拒绝提示、拖到边缘拒绝/向下分、重启后布局还原、启动页看板 都正常。修了 ChatArea hooks 顺序（格子在空/有 bot 间切换会崩）。分屏时格子标题栏只留「新对话」+ 最大化/关闭；侧栏显示格号角标。
- GitHub：草稿 PR #1（goxf/v12-workspace → goxf/portable）；仓库已开 Issues，下一版 #2–#7（同 handoff/next.md）。
- 侧栏「Hark 项目挂在账号下」没做：每格标题栏已有 Hark 项目切换下拉，重复；如用户仍要再做。
- 已快进合并到 goxf/portable（a3c1a43），测试包 v0.14.1-goxf.dev.a3c1a43（CI 出包后在 Releases 预发布里，未核实是否已发布）。

### 换账号接手从这里开始（15:28）
1. 先读 handoff/README.md 规则，再读本节；下一版待办 = handoff/next.md = GitHub Issue #2–#7；进行中 = 草稿 PR #1（已快进进 goxf/portable，PR 可直接关或留作记录）。
2. 等用户回答：① 默认打开 看板 还是 会话（现为看板，设置可改）；② 装 dev.a3c1a43 真机测：看板、切分/拖放/360px、重启还原、格号角标、后台通知；③ 早先未回：登录表单、浏览器卡、「已休眠」、更新卡、Windows 检查；④ 任务流水线（Issue #5，估 1–1.5 天）要不要开工。
3. 已知：src/main/mcp/hub.test.ts 全量跑偶发 3 个超时，单跑 7/7 通过（负载问题，非本次改动）。
4. 本地看界面：npx vite build -c vite.web.config.mts → 起静态服务 → playwright 打开 ?e2e=1，用 window.__bothub.store 灌假数据。
5. 推送：只推 origin 的 goxf/*；作者 GOXF <785937070@qq.com>；PR/Issue 用网页（PAT 无权限）。

## 2026-11-24 15:45 分支 goxf/feat-pane-tabs（Issue #2 格内标签页 + Issue #7 同一 bot 多对话分格）
- 格模型：叶子 = tabs[] + active；标签 = botId + 可选 conversationId（Hark 项目 / Muse·Hermes·Antigravity 会话）。旧 v13 布局（botId 叶子）自动升级（readPaneNode）。
- 标签条：分屏时或格内 ≥2 个标签时显示；点击切换、×/中键关闭、拖到别的格中间=并入、拖到边缘=切分；格内最后一个标签关掉则格关闭。
- 新开标签：侧栏 Ctrl/⌘+点击；侧栏拖到格中间（原「替换这一格」改为「加为标签」）；右栏会话列表（Muse/Hermes/Antigravity）中键或拖到格边缘；Hark 项目下拉中键。
- 聚焦标签决定 bot 当前对话（switchConversation）；在聚焦格切对话会把标签钉到新对话。非当前对话的标签显示只读镜像（ConversationMirror），Hark 实时（observeProject 改为按 subscription 并存），其他平台打开时读一次历史；点一下该格即切过去可发送。
- 不支持多对话（退回只按 bot）：Grok（会话绑定 agent，无会话列表）、Cue、Dot；群聊在「协作」页，不进会话格。
- 未真机/未网页目测（沙箱缺 chromium 依赖 libatk）。
## 2026-11-24 15:50 弹出独立窗口（next.md #2，分支 goxf/feat-popout，未合并）
- b7c9128：格子标题栏「弹出到独立窗口」→ 独立 BrowserWindow（同一渲染包 `?popout=<botId>`，只有聊天+输入框）；「放回主窗口」或关窗=放回（能右分就右分，否则进当前格）；侧栏点已弹出的会话=聚焦那个窗口。
- 同步：主窗口是唯一真实 store（适配器/持久化只在主窗口），节流 100ms 推补丁给弹出窗口；弹出窗口的 store 动作经主进程转发到主窗口执行（同手机同步 sendCommand 的按 id 应答）。弹出窗口不写 localStorage。
- 内嵌网页（WebContentsView）随会话移到弹出窗口、放回时移回（Muse pinned 辅助视图不动）。
- 位置大小存 userData/goxf-popouts.json，退出时开着的下次启动恢复（显示器不在就用默认位置）。Windows 上关主窗口=退出（弹出窗口保留到下次）。
- 验证：typecheck 过，vitest 479/479；网页版双页面 + BroadcastChannel 模拟主进程中继：弹出、主→弹实时消息、弹→主发送、放回都通过。未在 Windows/Electron 真机跑。

### 2026-11-24 15:50 合并
- ed80895：合并 feat-pane-tabs（1d0ce7d，格内标签 + 任意 bot 的会话单开一格）和 feat-popout（b7c9128，弹出独立窗口）；弹出时关掉该 bot 所有标签；ChatArea 恢复 headerExtra（PopoutApp 用）。typecheck ok，vitest 497/497。
- 效果图 v14（/workspace/work/mock/v14.py → v14-1-pipeline.png 流水线、v14-2-group-handoff.png 群组交接）已发，等「开工」（流水线约 1–1.5 天，交接约 2h）。
- 已知坑：回复中途切会话后半段落到新会话；恢复时账号未上线标签可能跟随当前会话；只读格滚动位置按 bot 存；弹出窗口里 Muse/Grok 授权卡未验证；主题不实时同步到弹出窗。
- 3d002c5：聊天里单张图片卡片贴合图片宽度（原来右侧留白）。未截图验证，等真机看。
- e78e1b1：默认打开「会话」（旧存档的看板自动迁移）。
- 131d132：合入上游 PR #50（6be4cba，Hark 工作区网页门户 + cloudflared 隧道 + 写入审批 + 相对路径提示；Grok rendered_card_kinds 部分不取，v0.14.1 #54 已修）。511 测试过。待真机：cloudflared.exe 放 BotArk-Data\bin、开门户/写入审批弹窗、Windows 路径、Hark 成员实跑、Grok 发送。
- 盘点第 4 项（Hark 验证码卡）其实 11-23 已做，只待真机。

## 2026-11-24 16:50 任务流水线（Issue #5，分支 goxf/feat-pipeline，未合并）
- 看板顶部加「状态 / 流水线」切换（存 botark-pipeline-v1）；状态视图内容不变，只多一行切换。
- 代码：src/renderer/src/pipeline/{model.ts 纯状态转换+关卡, pipelineStore.ts 持久化+派发, PipelineView.tsx, pipeline.test.ts}；BoardView.tsx 只加切换外壳。rooms 代码未改，只调用现有 submitBrief。
- 流程：新任务→需求；开了管理员调度时自动把「只拆分、写 执行者：名字 + 编号步骤、以 [FINAL] 回复」发进管理员调度群，解析出建议执行者和步骤→分配（确认分配 / 改给…；没开管理员就「去分配」手选）。执行者=单个 Bot（sendMessage 发到它的会话）或群组（submitBrief，群里 [FINAL] 自动推到 Review）。Bot 需手点「开发完成，提交 Review」（取它最新回复当产出）。新任务可选评审组，进 Review 时把需求+产出发给评审组，其 [FINAL] 显示在关卡上。Review / 人工确认：通过 / 打回（一句话原因，回开发第 N+1 轮，原因发给执行者）。上线列：确认上线对话框，可填 http(s) 上线地址（确认后浏览器打开），留空只标记。不跑命令、不打 tag。
- 同一个群的多条 brief 排队（submitBrief 会中断群里正在跑的回合）。
- 未做：命令型上线钩子（需新增主进程执行任意命令的 IPC，安全面大，故意没做）；真实「步骤 3/5·改了 N 个文件」（Bot 没有这类数据，只显示当前活动/群里第几轮）；Bot 开发完成自动识别；构建结果回写卡片；卡片编辑。
- 验证：typecheck 过，vitest 517/517；网页版假数据截图：六列、关卡、打回输入、上线对话框、新任务、只看要我处理的、切回状态 都正常。未在 Windows/Electron 真机跑。
## 2026-11-24 16:20–17:05 群组之间交接（Issue #6 / next.md 第 5 项，分支 goxf/feat-handoff，未合并）
- 按效果图 v14-2 做：[FINAL] 定稿卡下 复制 / 重新生成 / 交给其他群组；选择框列出其他群组（成员数 + 空闲/进行中）、附言、「由X组（管理员）自动开工」开关（手动 @ 且无管理员的组开关置灰：「收到后由你点名」）。
- 对方组收到「<源组> 交来需求」卡：附言 + 引用（引用 · 源组 bot 的定稿 [FINAL] 时间）+「查看原消息 →」跳回源组并定位高亮；自动开工 = submitBrief 正常派发（管理员组先给管理员）。turnPrompt 把引用当需求原文（isHumanRoomMessage 认 handoff 消息）。
- 右栏新标签「交接」：交接链 需求(你) → 各组(定稿/待开工/读需求中) → 人工确认(你)，带时间；交接规则 3 条。顶栏左侧 交接链 面包屑。侧栏收到的组显示「新需求」，打开即清。
- 数据：CollabRoom.handoffChain（链上所有组共享同一数组）/handoffUnread，RoomMessage.handoff {roomId,messageId}，随 rooms 持久化。submitBrief 新增可选 handoff、start=false（只发不开工）。
- 代码：rooms/handoff.ts(+handoff.test.ts 4 测)、rooms/HandoffViews.tsx；RoomView/RoomInspectorPanel/roomStore/model 只做增量改动（方便和 goxf/feat-pipeline 合并）。
- 「重新生成」= 用该定稿之前最后一条需求（含交来的引用）重新派发，会在群里再出现一次需求。
- 已知：右栏 4 个标签后「工作区/Slack」字被截断；链上组被删显示「已删除的群组」。网页版 playwright 假数据目测通过（选择框、交出、对方卡片、查看原消息跳回、右栏链）。未在 Windows/Electron 真机跑，未用真 bot 跑自动开工。
- 17:50 修：引用回复在气泡里重复显示（服务端文本带「> 引用」→拆回引用条，lib/quoteText.ts）；发送后短暂两条（本地消息已被服务端副本替换却仍保留，现跳过）；切回会话跳到上面（去掉滚动还原，切回总是到最新，ResizeObserver 在图片/卡片晚加载时保持贴底）。
- 2026-11-25 17:55 修：从「任务」切回 会话/协作 仍显示任务板（setScope 在看板时只改范围不换页；且进看板时侧栏范围没变，点已选中的「会话」不触发）。现在侧栏 会话/协作/任务 = 换页；进任务板侧栏同步到「任务」。
- 2026-11-25 18:00 侧栏会话行：未读数/完成点移到行右侧垂直居中（⋯ 的位置，悬停时被 ⋯ 替换）；悬停时文字列右侧留 24px，⋯ 不再压住预览文字。
