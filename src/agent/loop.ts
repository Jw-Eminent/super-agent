import { streamText, Tool, type ModelMessage } from 'ai';
import {
	detect,
	recordCall,
	recordResult,
	resetHistory,
} from './loop-detection';
import { calculateDelay, isRetryable, sleep } from './retry';
import { ToolRegistry } from '../tools/tool-registry';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

export interface BudgetState {
	used: number;
	limit: number;
}
export async function agentLoop(
	model: any,
	registry: ToolRegistry,
	messages: ModelMessage[],
	system: string,
	budget: BudgetState,
) {
	let step = 0;
	resetHistory();

	while (step < MAX_STEPS) {
		step++;
		process.stdout.write('Assistant: ');
		console.log(`\n -- Step ${step} --`);

		let hasToolCall = false;
		let fullText = '';
		let shouldBreak = false;
		let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
		let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

		for (let attempt = 1; ; attempt++) {
			try {
				const result = await streamText({
					model,
					tools: registry.toAISDKFormat(),
					messages,
					system,
					maxRetries: 0,
					onError: (error) => {},
				});
				for await (const chunk of result.fullStream) {
					switch (chunk.type) {
						case 'text-delta':
							process.stdout.write(chunk.text);
							fullText += chunk.text;
							break;
						case 'tool-call':
							hasToolCall = true;
							console.log(
								`   [工具调用: ${chunk.toolName} (${JSON.stringify(chunk.input)})]`,
							);

							const detection = detect(chunk.toolName, chunk.input);
							if (detection.stuck) {
								console.log(`  ${detection.message}`);

								if (detection.level === 'critical') {
									shouldBreak = true;
								} else {
									messages.push({
										role: 'user',
										content: [
											{
												type: 'text',
												text: `[系统提醒] ${detection.message}。请换个思路重新尝试，不要重复同样的操作`,
											},
										],
									});
								}
							}
							recordCall(chunk.toolName, chunk.input);
							break;
						case 'tool-result':
							// tool-result 自带 toolName/input，按本次结果配对，避免多工具时被 lastToolCall 覆盖
							console.log(`   [工具结果: ${chunk.output}]`);
							recordResult(chunk.toolName, chunk.input, chunk.output);
							break;
					}
				}
				// 拿到这一步的完整结果，追加到消息历史
				stepResponse = await result.response;
				stepUsage = await result.usage;
				break;
			} catch (error) {
				if (attempt >= MAX_RETRIES || !isRetryable(error)) {
					throw error;
				}
				const delay = calculateDelay(attempt);
				console.log(
					`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
				);
				await sleep(delay);
				hasToolCall = false;
				fullText = '';
				shouldBreak = false;
			}
		}
		if (shouldBreak) {
			console.log('\n[循环检测触发， Agent 已停止]');
			break;
		}

		messages.push(...stepResponse.messages);

		// Token 预算追踪：AI SDK 的 usage 已是扁平 number，不是 provider 层的 { total }
		const inp = stepUsage.inputTokens ?? 0;
		const out = stepUsage.outputTokens ?? 0;
		budget.used += inp + out;
		console.log(
			`  [预算] 本步 ${inp + out} tokens，累计 ${budget.used}/${budget.limit}`,
		);
		if (budget.used >= budget.limit) {
			console.log('\n[预算熔断] Token 用量已达上限，Agent 已停止');
			break;
		}

		// 退出条件：模型没有调用任何工具，说明它认为可以直接回复了
		if (!hasToolCall) {
			if (fullText) {
				console.log();
			}

			break;
		}

		// 还有工具调用 → 继续循环，让模型看到工具结果后继续思考
		console.log('  → 模型还在工作，继续下一步...');
	}

	if (step >= MAX_STEPS) {
		console.log('\n[达到最大步数限制，强制停止]');
	}
}
