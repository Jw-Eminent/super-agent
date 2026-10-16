import 'dotenv/config';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools';
import { agentLoop, BudgetState } from './agent/loop';

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

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
	const flags = [
		tool.isConcurrencySafe ? '可并发' : '串行',
		tool.isReadOnly ? '只读' : '读写',
	].join(', ');
	console.log(`  - ${tool.name}（${flags}）`);
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
			return;
		}
		messages.push({ role: 'user', content: trimmed });
		await agentLoop(model, registry, messages, system, budget);
		ask();
	});
}

console.log('Super Agent v0.4(type "exit" to quit)\n');
ask();
