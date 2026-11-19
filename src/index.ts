import 'dotenv/config';
import { UserModelMessage, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolDefinition, ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools';
import { agentLoop } from './agent/loop';
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
import { compactConversation } from './context/compressor.js';

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

async function main() {
	await connectMCP();

	console.log(`\n已注册 ${registry.getAll().length} 个工具：`);

	// session 持久化
	const isContinue = process.argv.includes('--continue');
	const sessionId = 'default';
	const store = new SessionStore(sessionId);
	// 必须把磁盘历史放进真正传给模型的 messages，否则 continue 只“读了文件”却不带上下文
	let messages: ModelMessage[] = [];
	if (isContinue && store.exists()) {
		messages = store.load();
		console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
	} else {
		// 新会话：清空旧文件，避免后续 replaceAll/append 和磁盘残留历史搅在一起
		store.clear();
		console.log(`[Session] 新会话（已清空历史文件）`);
	}

	// 压缩状态放在 index（会话层），不侵入 agentLoop
	let compactionSummary = '';

	/** @returns 内存是否被改写（micro 清空或 summary 压缩都算），需要 replaceAll 落盘 */
	async function applyCompaction(label: string): Promise<boolean> {
		const result = await compactConversation(
			model,
			messages,
			compactionSummary,
		);
		messages = result.messages;
		compactionSummary = result.summary;

		if (result.cleared > 0) {
			console.log(
				`  [压缩/micro] ${label}：清空 ${result.cleared} 条旧工具结果`,
			);
		}
		if (result.compressedCount > 0) {
			console.log(
				`  [压缩/summary] ${label}：压缩 ${result.compressedCount} 条消息`,
			);
		}
		// 以前只在 summarize 时 replaceAll，micro 清了内存却不写盘，jsonl 里搜不到 cleared
		return result.cleared > 0 || result.compressedCount > 0;
	}

	// 启动预压缩：continue 长历史先压一轮
	if (messages.length > 0) {
		console.log('[压缩] 启动前预压缩...');
		if (await applyCompaction('启动')) {
			store.replaceAll(messages);
		}
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

			// 调用前压一轮：让模型看到的是压缩后的历史
			let rewritten = await applyCompaction('调用前');

			const useMsg: UserModelMessage = { role: 'user', content: trimmed };
			messages.push(useMsg);

			const beforeLen = messages.length;
			await agentLoop(model, registry, messages, SYSTEM);

			// 调用后压一轮：清掉本轮工具结果膨胀，留给下一轮
			rewritten = (await applyCompaction('调用后')) || rewritten;

			if (rewritten) {
				store.replaceAll(messages);
			} else {
				// 用户消息 + 本轮新增的 assistant/tool
				store.appendAll(messages.slice(beforeLen - 1));
			}

			ask();
		});
	}

	console.log('Super Agent v0.8 — Session + Compaction (type "exit" to quit)');
	console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n');
	ask();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
