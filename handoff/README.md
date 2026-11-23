# 交接文件夹（goxf/portable 专用）

新账号 / 新会话接手时先读这里。

## 1. 先接通
- GitHub：保存登录 + PAT（覆盖 GOXF/botark、GOXF/hark-hub-go），只推 goxf/portable，不推上游、不开 PR。
- 服务器（root）：zovps.com、156.225.19.244、70.39.201.51
- MCP 桥：bridge-prod / bridge-dev.haisiku.com.cn 各一个 token
- 密码和令牌一律走安全表单，不进仓库、不进聊天。

## 2. 拉代码
```
git clone https://github.com/GOXF/botark.git && cd botark
git checkout goxf/portable
git remote add upstream https://github.com/qybaihe/botark.git && git fetch upstream
```

## 3. 读状态
- `handoff/handoff.md`：全部进度、遗留问题，末尾是最新交接段（当前状态以它为准）
- `handoff/pr-description.md`：上游 PR #38（Draft）说明

## 4. 规矩
- 中文回复、北京时间；开工前报预计时长。
- UI 改动先出效果图，用户说「开工」才写代码。
- 说「盘点」→ 四段汇总：等你回答 / 等你动手 / 我在做 / 搁置，带编号和总数。
- 正式 tag 前先升 goxfBuild；日常改动走测试通道。
- 每次结束前更新 `handoff/handoff.md` 并提交（提交信息带 [skip ci] 避免触发测试版构建）。
