# NGMixer

<p align="center">
  <a href="https://www.reaper.fm/">
    <img src="./assets/logos/reaper.jpg" alt="REAPER" height="96" align="middle" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/deepseek-ai/deepseek-harness">
    <img src="./assets/logos/deepseek-harness.svg" alt="DeepSeek Harness" width="80" height="80" align="middle" />
  </a>
</p>

像 vibe coding 一样混音！

[English](./README.en.md)

告诉 NGMixer 你想怎么改，它会读取当前工程、分析音量与响度，调整轨道和效果器，再渲染音频供你试听。混音师解放双手变甲方，最扬眉吐气的一集。

> “主唱再靠前一点，混响少一些，导出一版试听。”
>
> “这版人声合适了，鼓再轻一点。”

可以通过本地 WebUI 使用，也可以接入 QQ/NapCat，在私聊或群聊中发送素材、收听结果并反馈。

## 能做什么

- **分析工程**：读取轨道、路由和效果器，测量 Peak、RMS、LUFS 与 LRA。
- **调整混音**：修改轨道音量、发送音量和受支持的效果器参数，操作可在 REAPER 中撤销。
- **导入与试听**：导入音频、REAPER 工程或 ZIP 素材，输出 48 kHz WAV；安装 FFmpeg 后可输出 MP3。
- **根据反馈迭代**：记录每版试听及对应意见，用于下一轮调整，并保存个人混音偏好。
- **扩展混音知识**：加载外部知识包，为混音决策提供参考。仓库附带一份示例知识包。

默认使用 REAPER 自带效果器，也可扫描本机第三方插件并探测其参数。
> **Tips：** 部分第三方插件没有开放全部自动化参数，因此无法完全解放双手。FabFilter 系列目前支持完整，欢迎补充其他插件的情况。

## 快速开始

### 1. 准备环境

目前主要支持 macOS。开始前需要：

| 依赖 | 要求 |
| --- | --- |
| [REAPER](https://www.reaper.fm/download.php) | 7.x |
| Node.js | `>=22.19 <23` |
| Corepack / pnpm | 使用仓库指定的 pnpm 版本 |
| 模型服务 | DSH 支持的模型供应商及其凭据 |
| [FFmpeg](https://ffmpeg.org/download.html) | 可选，用于 MP3 导出和 QQ 媒体处理 |

### 2. 启动并配置

克隆仓库并启动：

```bash
git clone https://github.com/nanaoto/NGMixer.git
cd NGMixer
corepack enable
pnpm start
```

首次启动会自动安装依赖并打开配置向导。按提示设置 REAPER 路径、工作目录和插件扫描位置；需要 QQ 时，在向导中启用该通道。

本机配置保存在 `config/local.toml`。网页打开后，按下方[配置 LLM API](#配置-llm-api)选择供应商、填写密钥并设置默认模型。后续启动仍使用 `pnpm start`。

### 3. 连接 REAPER

打开 REAPER，在动作列表中加载配置向导生成的 `StartMixingAgentBridge.lua`，具体路径会显示在终端中：

`Actions → Show action list → New action… → Load ReaScript…`

选中并运行该脚本，然后在另一个终端中检查连接：

```bash
pnpm bridge:health
pnpm bridge:snapshot
```

### 4. 开始混音

在 REAPER 中打开工程，再打开终端显示的 WebUI 地址，默认为 `http://127.0.0.1:3080`。试着发送：

> 分析一下当前工程，把主唱调得靠前一点，然后导出 WAV 试听。

听完后，直接在对话中描述下一步想改的地方。

## 配置 LLM API

模型直接在 DSH 网页中配置。首次打开会显示 DeepSeek 密钥向导；使用其他供应商时点击 **稍后配置**。完成本机路径设置后：

1. 打开终端显示的 WebUI 地址，进入 **设置 → 模型**。
2. 点击 **添加提供方**，选择你使用的模型供应商，填写 API Key 并保存。
3. 在模型选择器中选择模型，设为默认模型，然后开始对话。

混音规划使用网页中设置的默认模型；更换默认模型后，下一次混音请求会使用新模型。已有对话可以单独选择聊天模型。

使用代理、中转或自建服务时，在模型设置中添加自定义提供方，填写接口地址与协议。支持读取模型列表的端点可以获取候选模型，也可以手动填写模型 ID。

模型设置保存在 `var/dsh/home/settings.yaml`，通过网页保存的 API Key 位于同目录下的 `.credentials.yaml`。这些文件都在 Git 忽略的 `var/` 目录中，重启后会继续使用。

如果此前已在 `config/local.toml` 配置 `[llm.*]`，项目仍沿用该配置，包括独立的混音规划模型。要切换到网页管理，先在网页添加供应商并选择默认模型，再删除 TOML 中全部 `[llm.*]` 配置段并重启。旧版 `[provider]` 配置同样需要移除。手动配置格式见[配置示例](./config/local.example.toml)。

## 用自己的资料建立混音知识库

目前已有 `mixing_knowledge` 检索工具，混音规划也会自动检索同一套知识包。你可以在对话中说：

> 查一下知识库里关于人声齿音的处理方法。

**目前没有将上传的 PDF、教程、网页或笔记自动整理入库的工具。** 接入自己的资料需要先整理成 Markdown，再注册为知识包：

1. 在 `knowledge/my-mixing/` 下准备按主题拆分的 Markdown 笔记，例如 `00-vocal-eq.md` 和 `10-vocal-compression.md`。每篇写清适用场景、判断方法、操作建议及资料来源。
2. 参考[示例 manifest](./knowledge/public-core/manifest.json) 创建 `knowledge/my-mixing/manifest.json`，填写知识包名称、版本、来源，以及每篇笔记的 `id`、`path`、`title` 和 `tags`。替换示例中的文档列表和来源信息。
3. 在 [knowledge/catalog.json](./knowledge/catalog.json) 的 `packs` 数组中追加 `{"path": "my-mixing/manifest.json"}`，保留原有条目。
4. 在对话中要求检索新笔记的主题，查看是否返回对应内容。检索会重新读取知识包文件。

文件名采用 `两位数字-英文主题.md`，首行必须是与 manifest 的 `title` 一致的一级标题。文档 ID 在所有知识包中保持唯一；每个包需要 2–64 篇文档，单篇最多 16 KiB，所有包正文合计最多 256 KiB。适合放整理过的混音笔记，长篇资料需要先提炼。

## 常用操作

在项目目录中运行：

| 命令 | 用途 |
| --- | --- |
| `pnpm start` | 启动 WebUI 和已启用的消息通道 |
| `pnpm doctor` | 检查本机路径、依赖和配置 |
| `pnpm bridge:health` | 检查 REAPER 桥接连接 |
| `pnpm bridge:snapshot` | 查看当前工程的轨道和效果器 |

桥接请求超时时，先确认 REAPER 已打开，并在动作列表中运行 `StartMixingAgentBridge.lua`。模型请求失败时，到 **设置 → 模型** 检查供应商凭据和默认模型；使用中转服务时同时核对接口地址、协议和模型 ID。

更新代码后，运行 `pnpm install --frozen-lockfile`，再运行 `pnpm start`。本机路径、模型设置和密钥会继续保留。

遇到问题或希望增加功能，可以在 [GitHub Issues](https://github.com/nanaoto/NGMixer/issues) 描述操作步骤、预期结果和实际表现。附上日志时请去掉密钥及个人文件路径。

## 工作原理

NGMixer 使用 DeepSeek Harness 组织对话和工具调用，由 TypeScript 运行时读取工程、执行混音计划，再通过 Lua 脚本操作 REAPER。每次渲染会记录试听版本，让后续反馈对应到你听到的那一版。

混音知识和个人偏好独立于模型保存，可随使用积累和更新。

## 开发

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm release:check
```

`pnpm check` 运行测试、类型检查、lint 和构建；`pnpm release:check` 检查发布文件、敏感信息和本机路径。

| 目录 | 内容 |
| --- | --- |
| `src/` | TypeScript 运行时、Agent 集成和混音逻辑 |
| `reaper/` | REAPER 桥接与渲染脚本 |
| `knowledge/` | 混音知识包 |
| `config/` | 配置示例 |
| `tests/` | 测试 |

## 许可证

原创代码和文档采用 [MIT License](./LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
