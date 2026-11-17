import 'dotenv/config';
import { UserModelMessage, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolDefinition, ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools';
import { agentLoop, BudgetState } from './agent/loop';
import { MCPClient, MockMCPClient } from './tools/mcp-client';
import { SessionStore } from './session/store';
import {
	coreRules,
	deferredTools,
	PromptBuilder,
	PromptContext,
	sessionContext,
	toolGuide,
} from './context/prompt-builder';

const system = `你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`;

const qwen = createOpenAI({
	baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
	apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
	? qwen.chat('qwen-plus-latest')
	: createMockModel();

const registry = new ToolRegistry();

const toolSearchTool: ToolDefinition = {
	name: 'tool_search',
	description:
		'获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description:
					'工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
	isConcurrencySafe: true,
	isReadOnly: true,
	execute: async ({ query }: { query: string }) => {
		const results = registry.searchTools(query);
		if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
		return results.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	},
};

registry.register(toolSearchTool, ...allTools);

const allCount = registry.getAll().length;
const activeTools = registry.getActiveTools();
const estimate = registry.countTokenEstimate();

console.log(`\n=== 工具统计 ===`);
console.log(`  全部工具: ${allCount} 个`);
console.log(`  活跃工具: ${activeTools.length} 个`);
console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
console.log(
	`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
);

async function connectMCP() {
	const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

	let canSpawn = true;
	try {
		const { execSync } = await import('node:child_process');
		execSync('echo test', { stdio: 'ignore' });
	} catch {
		canSpawn = false;
	}

	if (githubToken && canSpawn) {
		console.log('\n连接 GitHub MCP Server...');
		try {
			const client = new MCPClient(
				'npx',
				['-y', '@modelcontextprotocol/server-github'],
				{ GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
			);
			const tools = await registry.registerMCPServer('github', client);
			console.log(`  已注册 ${tools.length} 个 MCP 工具`);
			return;
		} catch (err) {
			console.log(
				`  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
			);
			console.log('  降级为 Mock MCP...');
		}
	}

	if (!githubToken) {
		console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
	}

	const mockClient = new MockMCPClient();
	const tools = await registry.registerMCPServer('github', mockClient);
	console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// 预算由调用方持有，跨轮持续累积；agentLoop 只负责消费它
// const budget: BudgetState = {
// 	used: 0,
// 	limit: 50000,
// };

async function main() {
	await connectMCP();

	console.log(`\n已注册 ${registry.getAll().length} 个工具：`);

	// session 持久化
	const isContinue = process.argv.includes('--continue');
	const sessionId = 'default';
	const store = new SessionStore(sessionId);
	// 必须把磁盘历史放进真正传给模型的 messages，否则 continue 只“读了文件”却不带上下文
	const messages: ModelMessage[] =
		isContinue && store.exists() ? store.load() : [];
	if (messages.length > 0) {
		console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
	} else {
		console.log(`[Session] 新会话`);
	}

	// Prompt Pipe 组装 system prompt
	const builder = new PromptBuilder()
		.pipe('coreRules', coreRules())
		.pipe('toolGuide', toolGuide())
		.pipe('deferredTools', deferredTools())
		.pipe('sessionContext', sessionContext());

	const promptCtx: PromptContext = {
		toolCount: registry.getActiveTools().length,
		deferredToolSummary: registry.getDeferredToolSummary(),
		sessionMessageCount: messages.length,
		sessionId,
	};

	const SYSTEM = builder.build(promptCtx);

	// Debug: 显示 Prompt Pipe 各模块状态
	builder.debug(promptCtx);

	for (const tool of registry.getActiveTools()) {
		const flags = [
			tool.isConcurrencySafe ? '可并发' : '串行',
			tool.isReadOnly ? '只读' : '读写',
		].join(', ');
		console.log(`  - ${tool.name}（${flags}）`);
	}

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	function ask() {
		rl.question('\nYou: ', async (input) => {
			const trimmed = input.trim();
			if (!trimmed || trimmed === 'exit') {
				console.log('Bye!');
				rl.close();
				await registry.closeAllMCP();
				return;
			}

			const useMsg: UserModelMessage = { role: 'user', content: trimmed };
			messages.push(useMsg);
			store.append(useMsg);

			const beforeLen = messages.length;
			// await agentLoop(model, registry, messages, system, budget);
			await agentLoop(model, registry, messages, SYSTEM);

			// 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
			const newMessages = messages.slice(beforeLen);
			store.appendAll(newMessages);

			ask();
		});
	}

	console.log('Super Agent v0.7 — Session + Prompt Pipe (type "exit" to quit)');
	console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n');
	ask();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
