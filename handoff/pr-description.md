标题：fix(hark): project create autoTitle, Turnstile login, paste import, project sync

修复 Hark 相关的四个问题：

1. 新建项目报 "autoTitle is required for projects"
POST /conversations 只传了 title，补上 timezone 和 autoTitle（用户填了标题为 false，空标题为 true）。

2. 邮箱登录 Cloudflare Turnstile 一直验证失败
登录窗口删掉 UA 里的 Electron/BotArk 标识后 setUserAgent，与 navigator.userAgentData / Worker 指纹不一致；REST 请求又写死 macOS + Chrome 134 的 UA 和 sec-ch-ua，每 1.2 秒用同一 cookie 轮询。现统一使用 Electron 原生 UA，仅 Google OAuth 主机使用清洗过的 UA。
参考：https://github.com/akriaueno/electron-turnstile-repro

3. 新建 Bot 里「粘贴凭据导入」失败、导入后仍显示登录页
导入成功后又调用 cancelLogin → clearStorageData，清掉了刚写入的会话 cookie。新建 Bot 与设置共用同一导入函数，不再清数据；登录/导入成功后刷新该账号的网页视图。

4. Hark 项目列表不同步
列表只在挂载/切换账号时拉取一次。现在窗口聚焦、页面可见、打开项目下拉时刷新（5 秒节流），可见时每 60 秒轮询，新建的项目先乐观显示。

测试：vitest 53 个文件 235 个测试通过，typecheck node/web 通过。尚未在真机上验证，先开草稿。

已知未处理：Dot 的粘贴导入也调了 cancelLogin；webContentsViewManager 的聊天视图仍会改写 UA；代理出口 IP 与系统时区不一致的情况。