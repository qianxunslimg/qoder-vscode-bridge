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
- 支持把 VS Code Chat 中粘贴的图片转发给 Qoder；只有账号目录标记为“视觉”的模型会声明图片能力，图片会作为真实多模态输入发送，不再降级成 MIME 占位文本。
- 保留原生模型选择器；当 Copilot Chat 提供 Bash、Read、Edit 等工具时，Qoder 会通过代理把工具调用交给 VS Code 原生工具循环，结果回传后继续同一 Qoder 会话。
- 原生工具链路默认保留 VS Code 当前提供的完整工具集合；用户主动调低工具上限时才优先保留核心编码工具。工具调用、确认、结果、取消和错误重试交给 VS Code；无工具的普通文本请求继续使用轻量文本路径。
- `maxTurns` 只交给 Qoder SDK 约束 Agent 轮数，不再错误地按单个宿主工具调用重复计数；旧工具结果对应的内存会话已结束时，会从当前聊天记录和工作区状态重新建立会话，避免“Try Again”反复报 `session expired`。
- 仍支持 Qoder 的文本流、内部回退循环、取消请求、用量查询和权限模式。
- 原生链路由 Qoder 在第一次工具调用前给出一句任务相关计划，之后直接使用 VS Code 原生工具卡，不再重复输出“调用工具/收到结果”等成功态文本；失败时保留重试提示。
- 终端同步任务会保留宿主参数说明并修正明显的秒/毫秒误用，避免普通构建或测试因过短 timeout 被宿主转到后台；如果终端通知仍与结果查询发生竞态，也会续接原来的 Qoder 会话，而不是误启动第二个会话。
- 宿主提供 `read_file` 时优先使用宿主实现，因此可以继续读取 Copilot 为大工具结果生成的 `chat-session-resources` 文件；仅在宿主没有读取工具时才保留工作区限定的 `qoder_read_file` 作为兜底。
- 内部回退链路继续显示可审计的活动摘要：分析状态、工具操作、脱敏后的命令摘要和有限结果预览。

## 当前边界

- 不展示模型的原始隐藏思维链（Chain of Thought）。界面显示的是可审计的过程摘要，不是模型内部推理全文。
- 当前实现是 Language Model Provider，不提供独立的 `@qoder` Chat Participant 或原生 Qoder Session Target。
- 图片输入需要选择 Qoder 账号目录中标记为视觉的模型；非视觉模型会在请求开始时给出明确错误，不会假装已经看到了图片。
- 原生工具委托按 Chat 请求中的工具集合动态建立代理，避免 Qoder SDK 再启动一套同名内置工具；如果请求没有宿主工具，才回退到文本路径。
- 工具是否可以读取或修改工作区由 Qoder 与 VS Code 宿主共同决定；Qoder 默认使用 `bypassPermissions`，宿主工具确认仍由 VS Code 控制。
- 作为兜底的 `qoder_read_file` 仍只允许读取当前工作区内的 UTF-8 文件，并由 VS Code 的工具确认 UI 控制是否执行；不会为了读取宿主临时结果而放宽到整个用户目录。
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
| `qoderBridge.permissionMode` | `bypassPermissions` | Qoder 工具权限模式；默认跳过 Qoder 侧审批，VS Code 宿主工具是否确认仍由宿主控制。可选 `auto`、`acceptEdits`、`default`、`plan`、`bypassPermissions`、`yolo`、`dontAsk`。 |
| `qoderBridge.maxTurns` | `30` | 单次请求最多执行的 Agent 循环轮数。 |
| `qoderBridge.includePartialMessages` | `true` | 尽可能把流式文本增量显示到 Chat。 |
| `qoderBridge.showActivity` | `true` | 是否显示分析、工具、任务、结果、重试和完成状态摘要。 |
| `qoderBridge.nativeToolLoop` | `true` | 是否把 Chat 请求提供的 Bash、Read、Edit 等工具交给 VS Code 原生工具循环。 |
| `qoderBridge.maxNativeTools` | `91` | 单次请求最多暴露给 Qoder 的宿主工具数；默认覆盖 VS Code 当前完整工具集合。主动调低时核心编码工具优先。 |

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
