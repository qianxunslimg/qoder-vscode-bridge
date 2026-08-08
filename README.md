# Qoder VS Code Bridge

把公司提供的企业版 Qoder 接入 VS Code 原生 Chat，也就是 Copilot 所在的聊天入口。

## 为什么需要这个项目

公司已经提供了企业版 Qoder 的使用权限，但 Qoder 官方 CLI 和独立编辑器在日常开发中的使用体验不够顺手。这个扩展保留 Qoder 的模型和 Agent 能力，同时继续使用熟悉的 VS Code 工作区、编辑器、终端、Git 和 Chat 界面。

它不是另起一个聊天客户端，也不绕过企业认证，而是把 Qoder 注册成 VS Code 的语言模型提供商，让 Qoder 模型出现在原生模型选择器里。

## 工作方式

```text
VS Code 原生 Chat / Copilot
            │
            ▼
Qoder VS Code Bridge（Language Model Provider）
            │
            ▼
Qoder Agent SDK ── 企业版 Qoder 服务
```

访问令牌只用于本地扩展与 Qoder 服务通信，不会写入项目源码或 VS Code 设置文件。

## 当前功能

- 在 VS Code 原生 Chat 的模型选择器中提供 Qoder。
- 从 Qoder 账号目录加载具体模型，使用真实模型 ID 路由请求。
- 支持 Qwen、Kimi、DeepSeek、GLM、MiniMax 等账号中可用的模型；目录暂时不可用时保留 tier 别名。
- 根据模型可用信息选择最大的上下文窗口，不再统一固定为 123K。
- 将当前 Chat 消息和第一个受信任工作区转发给 Qoder Agent SDK。
- 保留原生模型选择器；当 Copilot Chat 提供桥接工具时，Qoder 的只读文件调用会转换为 VS Code 原生工具调用，工具结果回传后再继续 Qoder 会话。
- 原生工具链路目前只开放 `qoder_read_file`，支持一次执行、取消、确认和错误后的再次调用；其他工具暂时保留 Qoder 内部工具循环。
- 支持 Qoder 的文本流、内部工具循环、取消请求、用量查询和权限模式。
- 第一次执行工具或子任务时显示执行计划，后续显示轮次、步骤和任务进度摘要，避免连续刷出重复的“正在分析”。
- 在 Chat 中显示可审计的活动摘要：分析状态、工具操作、脱敏后的命令摘要、工具结果、失败、重试和完成状态。小结果直接展示；大结果显示有限的首尾预览并标出省略行数，避免读取大文件时刷屏；需要完整内容时可让 Qoder 按文件或行范围读取。

## 当前边界

- 不展示模型的原始隐藏思维链（Chain of Thought）。界面显示的是可审计的过程摘要，不是模型内部推理全文。
- 当前实现是 Language Model Provider，不提供独立的 `@qoder` Chat Participant 或原生 Qoder Session Target。
- 原生工具委托是渐进迁移：只有 Chat 请求把 `qoder_read_file` 作为唯一可用工具时才启用；如果请求还包含其他工具，自动回退到原有 Qoder 内部工具循环，避免当前只迁移一个工具而影响 Agent 模式的编辑和命令能力。
- 工具是否可以读取或修改工作区由 Qoder 的权限模式决定，默认使用 `auto`，执行修改操作前应检查 Chat 中的活动信息。
- 原生 `qoder_read_file` 只允许读取当前工作区内的 UTF-8 文件，并由 VS Code 的工具确认 UI 控制是否执行。
- 不包含企业账号管理、令牌申请或服务端代理能力。

## 安装和使用

### 从源码打包

需要 VS Code `1.106.0` 或更高版本，以及 Node.js/npm：

```sh
npm install
npm run package
```

然后在 VS Code 中执行 `Extensions: Install from VSIX...`，选择生成的 `qoder-vscode-bridge-*.vsix`，安装后执行 `Developer: Reload Window`。

### 配置令牌并选择模型

1. 打开命令面板，执行 `Qoder: Set Personal Access Token`。
2. 粘贴公司提供的 Qoder 企业版访问令牌。令牌会保存到 VS Code `SecretStorage`。
3. 打开原生 Chat，点击模型选择器。
4. 选择 `Qoder` 下的具体模型。
5. 如果模型列表没有及时更新，执行 `Qoder: Refresh Model Catalog`。

其他命令：

- `Qoder: Clear Personal Access Token`：清除本地令牌。
- `Qoder: Show Usage`：查看当前账号用量（如果企业账号提供该信息）。

## 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `qoderBridge.permissionMode` | `auto` | Qoder 工具权限模式。 |
| `qoderBridge.maxTurns` | `30` | 单次请求最多执行的 Agent 循环轮数。 |
| `qoderBridge.includePartialMessages` | `true` | 尽可能把流式文本增量显示到 Chat。 |
| `qoderBridge.showActivity` | `true` | 是否显示分析、工具、任务、结果、重试和完成状态摘要。 |
| `qoderBridge.nativeToolLoop` | `true` | Chat 仅提供 `qoder_read_file` 时，是否把只读文件调用交给 VS Code 原生工具循环。 |

## 开发和验证

```sh
npm install
npm run compile
npm test
npm run package
```

在 VS Code 中按 `F5` 可以启动 Extension Development Host。测试命令只从当前进程环境变量读取令牌，不会把令牌写入仓库：

```sh
QODER_PERSONAL_ACCESS_TOKEN='你的PAT' npm run smoke
QODER_PERSONAL_ACCESS_TOKEN='你的PAT' npm run catalog:smoke
QODER_PERSONAL_ACCESS_TOKEN='你的PAT' npm run model:smoke
QODER_PERSONAL_ACCESS_TOKEN='你的PAT' npm run native:smoke
QODER_PERSONAL_ACCESS_TOKEN='你的PAT' npm run provider:native:smoke
```

不要把真实 PAT 粘贴到 README、源码、日志或 Git 提交中。

## 项目结构

- `src/provider.ts`：VS Code Language Model Provider 和请求转发。
- `src/nativeToolLoop.ts`：Qoder 代理工具、原生工具调用边界和会话续接。
- `src/nativeReadFileTool.ts`：工作区只读文件工具、确认和取消处理。
- `src/modelCatalogService.ts`：Qoder 账号模型目录刷新与缓存。
- `src/messageAdapter.ts`、`src/promptPolicy.ts`：Chat 消息转换和 prompt 压缩。
- `src/activity.ts`：可审计活动摘要和敏感信息脱敏。
- `src/tokenStore.ts`：VS Code SecretStorage 令牌存储。
- `test/`：模型目录、prompt 和活动流测试。

## 许可证

MIT
