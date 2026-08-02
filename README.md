# AgentDesk

AgentDesk 是一个本地运行的个人 Coding Agent 驾驶舱。它负责准备多仓库
Git Worktree、启动 Codex、Qoder 或 Qwen Code、记录结构化事件，并在浏览器中处理
Agent 的提问和权限申请。

## 环境要求

- Node.js 20+
- pnpm 10+
- Git
- 至少安装并登录 Codex CLI、QoderCLI 或 Qwen Code 之一

## 启动

```powershell
pnpm.cmd install
pnpm.cmd build
.\start-agentdesk.cmd
```

打开 <http://127.0.0.1:4310>。

开发模式使用：

```powershell
pnpm.cmd dev
```

开发页面监听 <http://localhost:5173>，本地 API 监听
<http://127.0.0.1:4310>。

## Agent 配置

### Qwen Code

安装并完成一次交互式认证：

```powershell
npm install -g @qwen-code/qwen-code@latest
qwen --version
qwen
```

AgentDesk 通过 Qwen Code 的 `stream-json` 无头模式展示实时事件，并使用
`auto` 审批模式自动执行工作区内编辑、常规构建和测试，同时拦截高风险操作。
后续指令会通过 Qwen Code session id 恢复同一会话。若命令不在 `PATH` 中，设置：

```powershell
$env:AGENTDESK_QWEN_CODE_COMMAND = "D:\tools\qwen.exe"
```

### Qoder

先在终端完成登录并确认命令可用：

```powershell
qodercli --version
qodercli
```

AgentDesk 使用 Qoder Agent SDK，并通过 `qodercliAuth()` 复用本地登录。

### Codex

AgentDesk 需要可从普通终端执行的独立 Codex CLI，而不是仅存在于 Windows
商店应用内部的受限可执行文件：

```powershell
npm install -g @openai/codex
codex --version
codex login
```

如果 CLI 不在 PATH 中，可在启动前指定完整路径：

```powershell
$env:AGENTDESK_CODEX_COMMAND = "D:\tools\codex.exe"
.\start-agentdesk.cmd
```

Qoder 同样支持 `$env:AGENTDESK_QODER_COMMAND`。

## 使用流程

1. 新建任务，选择 Codex、Qoder 或 Qwen Code。
2. 填写需求材料和本地仓库路径。
3. 点击“准备工作区”，AgentDesk 会在 `.agentdesk/workspaces` 中创建
   任务目录及 Git Worktree。
4. 填写本轮指令并启动 Agent。
5. 在时间线中查看消息、命令、文件修改、提问与审批。

## LLM Wiki 知识飞轮

所有内置工作流都会在开发、代码审查和目标验收之后启动一个全新的“需求知识审查”
Agent。该 Agent 采用 LLM Wiki 的三层模型，把原始证据、主题化 Wiki 和维护规则分离：

1. 汇总原始需求、上传材料、已确认需求规格、用户补充、交互确认、审查/验收报告和 Git Diff。
2. 在每个代码仓库的 `knowledge/` 下创建或维护主题化 Markdown Wiki。
3. 优先更新已有主题页面，不为每个需求机械生成孤立总结。
4. 对稳定知识记录来源、适用范围、状态和最后验证日期；证据不足时标为 `candidate`。
5. 知识 Agent 只允许修改 `knowledge/`；如果它改变业务代码、测试或配置，工作流会失败并阻止提交。
6. 带人工审核门禁的工作流会在知识更新后展示最终代码与知识 Diff，再由用户确认提交。

每个仓库首次执行知识审查时会自动生成：

```text
knowledge/
├── README.md
├── AGENTS.md
├── index.md
└── wiki/
```

这里集成的是 Git 原生的 LLM Wiki 工作模式和 Agent 生命周期，不依赖单独运行的
向量数据库或 Wiki 服务；Markdown 是知识本体，未来可以再接入全文或语义检索作为
可重建索引。

## 安全边界

- 服务默认只监听 `127.0.0.1`。
- Agent 工作目录限制在任务工作区。
- AgentDesk 不会自动批准 Codex 的命令或文件修改请求。
- Worktree 创建前会验证源路径确实属于 Git 仓库。

## 构建

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

运行数据保存在仓库根目录的 `.agentdesk` 中，包括 SQLite 数据库、上传材料和
各任务的 Worktree 工作区。该目录已加入 `.gitignore`。
