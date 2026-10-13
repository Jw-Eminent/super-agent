import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const RESPONSES: Record<string, string> = {
	default:
		'你好！我是模拟模型。填了 DASHSCOPE_API_KEY 后会自动切换到真实的 Qwen。',
	greeting: '你好！虽然是模拟的，但流式输出的效果和真实 API 一致 :)',
	name: '你刚才告诉我了呀！我能"记住"是因为代码把对话历史传给了我。',
	intro: '我是通义千问（模拟版），在本地模拟回复，机制和真实 API 完全一致。',
};

function pickResponse(prompt: unknown): string {
	const messages = Array.isArray(prompt) ? prompt : [];
	const userMsgs = messages.filter((m: { role?: string }) => m.role === 'user');
	const last = userMsgs[userMsgs.length - 1] as
		{ content?: Array<{ text?: string }> } | undefined;
	const text = (last?.content || [])
		.map((c) => c.text || '')
		.join('')
		.toLowerCase();
	if (text.includes('介绍你自己') || text.includes('你是谁'))
		return RESPONSES.intro;
	if (text.includes('你好') || text.includes('hello'))
		return RESPONSES.greeting;
	if (text.includes('叫什么') || text.includes('记住')) return RESPONSES.name;
	return RESPONSES.default;
}

const USAGE = {
	inputTokens: {
		total: 10,
		noCache: 10,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 20, text: 20, reasoning: undefined },
};

export function createMockModel() {
	return new MockLanguageModelV3({
		provider: 'mock',
		modelId: 'mock-model',
		doGenerate: async ({ prompt }) => ({
			content: [{ type: 'text' as const, text: pickResponse(prompt) }],
			finishReason: { unified: 'stop' as const, raw: undefined },
			usage: USAGE,
			warnings: [],
		}),
		doStream: async ({ prompt }) => {
			const text = pickResponse(prompt);
			const id = 'text-1';
			return {
				stream: simulateReadableStream({
					chunkDelayInMs: 30,
					chunks: [
						{ type: 'text-start' as const, id },
						...text.split('').map((char) => ({
							type: 'text-delta' as const,
							id,
							delta: char,
						})),
						{ type: 'text-end' as const, id },
						{
							type: 'finish' as const,
							finishReason: { unified: 'stop' as const, raw: undefined },
							usage: USAGE,
						},
					],
				}),
			};
		},
	});
}
