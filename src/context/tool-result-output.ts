import type { ToolResultPart } from 'ai';

/**
 * 工具结果在 AI SDK 里不是简单的 string，而是带判别字段的联合类型 ToolResultOutput：
 * text / json / content / error-* / execution-denied 等。
 *
 * 本文件做两件事：
 * 1. 把各种形态的 output 展平成可读文本（日志、token 估算、压缩摘要用）
 * 2. 构造纯文本形态的 output（微压缩时用占位符替换旧结果）
 */

/** 从 ToolResultPart 抽出 output 字段类型，避免自己手写一整套联合类型 */
type ToolResultOutput = ToolResultPart['output'];

/** content 形态下 value 数组里每一项（text / file / file-id / image-url ...） */
type ContentPart = Extract<
	ToolResultOutput,
	{ type: 'content' }
>['value'][number];

/**
 * 格式化 content 数组里的单个 part。
 * 只有 text 有正文；file 等可能带 mediaType；file-id 等没有 mediaType，只能标类型名。
 */
function formatContentPart(part: ContentPart): string {
	if (part.type === 'text') return part.text;
	// 必须用 in 收窄：非 text 分支并不都有 mediaType
	if ('mediaType' in part && part.mediaType) {
		return `[media: ${part.mediaType}]`;
	}
	return `[${part.type}]`;
}

/**
 * 把 ToolResultOutput 转成纯文本。
 * compressor 估算 token、拼摘要对话时都会走这里，避免直接 String(object) 得到无用信息。
 */
export function toolResultOutputToText(output: ToolResultOutput): string {
	switch (output.type) {
		case 'text':
		case 'error-text':
			return output.value;
		case 'json':
		case 'error-json':
			return JSON.stringify(output.value, null, 2);
		case 'execution-denied':
			return output.reason ?? 'Tool execution denied';
		case 'content':
			// 多段内容（文本 + 文件/图片引用）拼成一行行文本
			return output.value.map(formatContentPart).join('\n');
		default: {
			// 穷尽检查：以后 SDK 加了新 type，这里会在编译期报错提醒补分支
			const _exhaustive: never = output;
			return String(_exhaustive);
		}
	}
}

/**
 * 构造 type: 'text' 的 ToolResultOutput。
 * microcompact 清空旧工具结果时，用它写成 `[tool result cleared]` 占位，保持消息结构合法。
 */
export function textToolResultOutput(value: string): ToolResultOutput {
	return { type: 'text', value };
}
