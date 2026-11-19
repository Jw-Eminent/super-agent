import { generateText, type ModelMessage } from 'ai';
import {
	textToolResultOutput,
	toolResultOutputToText,
} from './tool-result-output.js';

/**
 * 粗估 token 数：中英混排大约 4 字符 ≈ 1 token。
 * 用来判断要不要触发压缩，不要求精确。
 */
function estimateTokens(messages: ModelMessage[]): number {
	let chars = 0;
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			chars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if ('text' in part && typeof part.text === 'string') {
					chars += part.text.length;
				} else if ('output' in part) {
					// tool-result 的 output 可能是 text/json/content 等，先转成纯文本再计长
					chars += toolResultOutputToText(part.output).length;
				}
			}
		}
	}
	return Math.ceil(chars / 4);
}

// ── Layer 1: Microcompact（微压缩，不调 LLM）────────────
// 思路：历史里的工具结果往往很长（读文件、跑命令），但旧结果通常已经没用了。
// 只保留最近几次工具结果的原文，更早的可清除工具结果替换成占位符，立刻省 token。

/** 这些工具的结果「内容」过期后价值低，可以清掉；搜索/MCP 等可能仍有引用价值，默认保留 */
const CLEARABLE_TOOLS = new Set([
	'read_file',
	'bash',
	'grep',
	'glob',
	'list_directory',
	'edit_file',
	'write_file',
]);
/** 最近 N 次 tool 消息保留原文，更早的才考虑清空 */
const KEEP_RECENT_TOOL_RESULTS = 3;

/**
 * 第一层压缩：清空过旧的可清除工具结果。
 * - 不调用模型，成本几乎为 0
 * - 消息条数不变，只是把旧 tool output 换成 `[tool result cleared]`
 */
export function microcompact(messages: ModelMessage[]): {
	messages: ModelMessage[];
	cleared: number;
} {
	let cleared = 0;
	const toolResultIndices: number[] = [];

	// 先收集所有 role=tool 的消息下标
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === 'tool' && Array.isArray(msg.content)) {
			toolResultIndices.push(i);
		}
	}

	// 只清「除最近 KEEP_RECENT_TOOL_RESULTS 条之外」的旧 tool 结果
	const toClear = toolResultIndices.slice(
		0,
		Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
	);

	const result = messages.map((msg, idx) => {
		if (!toClear.includes(idx)) return msg;
		if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

		const toolName = (msg.content[0] as any)?.toolName || 'unknown';
		// 不在白名单里的工具结果原样保留
		if (!CLEARABLE_TOOLS.has(toolName)) return msg;

		cleared++;
		return {
			...msg,
			content: msg.content.map((part: any) => ({
				...part,
				output: textToolResultOutput('[tool result cleared]'),
			})),
		};
	});

	return { messages: result, cleared };
}

// ── Layer 2: LLM Summarization（摘要压缩，会调模型）──────
// 思路：token 或消息过多时，把「较早的对话」交给 LLM 压成结构化摘要，
// 只把「摘要 + 最近几条原文」继续传给 Agent，实现真正减量。

/** 压缩用的 system prompt：要求输出固定模板，方便后续轮次接上上下文 */
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

/** 粗估超过该 token 阈值才考虑摘要（演示阈值偏低，生产通常更高） */
const CONTEXT_TOKEN_THRESHOLD = 600;
/** 摘要时始终保留最近 N 条消息原文，避免丢掉正在进行的上下文 */
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
	messages: ModelMessage[];
	summary: string;
	compressedCount: number;
}

/**
 * 第二层压缩：用 LLM 把旧消息总结成摘要消息。
 *
 * 流程：
 * 1. token / 条数未超阈值 → 直接返回，不压缩
 * 2. 从尾部保留最近消息，切分点尽量对齐到 user 消息，避免拆开一轮对话
 * 3. 把旧段拼成文本（可叠加已有摘要），调用 generateText 生成结构化摘要
 * 4. 用「摘要 user 消息 + 最近原文」替换整段历史
 * 5. 模型调用失败则原样返回，保证可用性
 */
export async function summarize(
	model: any,
	messages: ModelMessage[],
	existingSummary?: string,
): Promise<CompactionResult> {
	const tokenEstimate = estimateTokens(messages);
	if (
		tokenEstimate < CONTEXT_TOKEN_THRESHOLD ||
		messages.length <= KEEP_RECENT_MESSAGES
	) {
		return { messages, summary: existingSummary || '', compressedCount: 0 };
	}

	const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

	// 向前对齐到最近的 user 消息，保证不把 assistant/tool 半截对话留在「保留区」开头
	let alignedIdx = splitIdx;
	while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
		alignedIdx--;
	}
	// 对齐失败（整段都不是从 user 切开）→ 放弃压缩，避免结构损坏
	if (alignedIdx === 0) {
		return { messages, summary: existingSummary || '', compressedCount: 0 };
	}

	const toCompress = messages.slice(0, alignedIdx);
	const toKeep = messages.slice(alignedIdx);

	// 把待压缩消息展平成可读对话文本，供摘要模型消费
	const conversationText = toCompress
		.map((msg) => {
			const content =
				typeof msg.content === 'string'
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
								.map((part) =>
									'text' in part
										? part.text
										: 'output' in part
											? toolResultOutputToText(part.output)
											: '',
								)
								.join('')
						: '';
			return content ? `**${msg.role}**: ${content}` : '';
		})
		.filter(Boolean)
		.join('\n\n');

	if (!conversationText.trim()) {
		return { messages, summary: existingSummary || '', compressedCount: 0 };
	}

	// 若已有上一次摘要，让模型在旧摘要基础上增量合并，而不是只看新片段
	const userPrompt = existingSummary
		? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
		: conversationText;

	try {
		const { text: summary } = await generateText({
			model,
			system: COMPRESS_PROMPT,
			prompt: userPrompt,
		});

		// 摘要伪装成一条 user 消息插到最近对话前面，模型下一轮就能读到压缩后的上下文
		const summaryMessage: ModelMessage = {
			role: 'user',
			content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
		};

		const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];

		return {
			messages: newMessages,
			summary,
			compressedCount: toCompress.length,
		};
	} catch (err) {
		console.error('[Compaction] LLM 摘要失败:', err);
		return { messages, summary: existingSummary || '', compressedCount: 0 };
	}
}

/**
 * 对外统一入口：先 microcompact，再按需 summarize。
 * 返回新的 messages（可能是原数组引用，也可能是摘要后的新数组）。
 */
export async function compactConversation(
	model: any,
	messages: ModelMessage[],
	existingSummary = '',
): Promise<{
	messages: ModelMessage[];
	summary: string;
	cleared: number;
	compressedCount: number;
}> {
	const micro = microcompact(messages);
	const result = await summarize(model, micro.messages, existingSummary);
	return {
		messages: result.messages,
		summary: result.summary || existingSummary,
		cleared: micro.cleared,
		compressedCount: result.compressedCount,
	};
}

export { estimateTokens };
