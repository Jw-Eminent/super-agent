import 'dotenv/config';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools';
import { agentLoop, BudgetState } from './agent/loop';
import { MCPClient, MockMCPClient } from './tools/mcp-client';

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
registry.register(...allTools);

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

const messages: ModelMessage[] = [];
// 预算由调用方持有，跨轮持续累积；agentLoop 只负责消费它
const budget: BudgetState = {
	used: 0,
	limit: 15000,
};
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
		messages.push({ role: 'user', content: trimmed });
		await agentLoop(model, registry, messages, system, budget);
		ask();
	});
}

async function main() {
	await connectMCP();

	console.log(`\n已注册 ${registry.getAll().length} 个工具：`);
	for (const tool of registry.getAll()) {
		const flags = [
			tool.isConcurrencySafe ? '可并发' : '串行',
			tool.isReadOnly ? '只读' : '读写',
		].join(', ');
		console.log(`  - ${tool.name}（${flags}）`);
	}

	console.log('Super Agent v0.5(type "exit" to quit)\n');
	ask();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
