# Super Agent

一个在终端里对话的软件开发助手。它会记住当前会话的上下文，并在需要时调用工具后再继续回答。

配置了阿里云百炼的 API Key 时，使用通义千问（`qwen-plus-latest`）。没有 Key 时自动切换到本地模拟模型，方便离线看流式输出效果。

## 功能

- 终端多轮对话，输入 `exit` 退出
- 最多 10 步的 Agent 循环：模型调用工具后会把结果写回对话，再继续思考
- 内置两个演示工具：
  - `get_weather`：按城市返回天气（目前是本地假数据，支持北京、上海、深圳）
  - `calculator`：计算数学表达式

## 环境要求

- Node.js 20 或更高版本
- [pnpm](https://pnpm.io/) 12（项目锁定为 `pnpm@12.11.2`）

## 开始使用

```bash
pnpm install
```

在项目根目录创建 `.env`（不要提交到 Git）：

```bash
DASHSCOPE_API_KEY=你的百炼 API Key
```

不填这个变量也可以运行，此时会使用模拟模型。

```bash
pnpm dev    # 监听文件变化并重启
pnpm start  # 直接启动
```

启动后在 `You:` 提示符后输入问题。例如问「北京天气怎么样」或「2 + 3 * 4 等于多少」，可以看到工具调用和返回。

## 目录

```
src/
  index.ts                 # 入口：读取环境变量、选择模型、启动对话
  agent/loop.ts            # Agent 循环与流式输出
  tools/utility-tools.ts   # 天气、计算器工具
  mock-model.ts            # 无 API Key 时的模拟模型
```
