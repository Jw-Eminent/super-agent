import { streamText, Tool, type ModelMessage } from 'ai';

const MAX_STEPS = 10;

export async function angetLoop(
	model: any,
	tools: Record<string, Tool>,
	messages: ModelMessage[],
	system: string,
) {
	let step = 0;
	while (step < MAX_STEPS) {
		step++;
		process.stdout.write('Assistant: ');
		console.log(`\n -- Step ${step} --`);
		const result = await streamText({
			model,
			tools,
			messages,
			system,
		});

		let hasTollCall = false;
		let fullText = '';

		for await (const chunk of result.fullStream) {
			switch (chunk.type) {
				case 'text-delta':
					process.stdout.write(chunk.text);
					fullText += chunk.text;
					break;
				case 'tool-call':
					hasTollCall = true;
					console.log(
						`\n [工具调用: ${chunk.toolName} (${JSON.stringify(chunk.input)})]`,
					);
					break;
				case 'tool-result':
					console.log(`\n [工具返回: ${chunk.output}]`);
					break;
			}
		}
		// 拿到这一步的完整结果，追加到消息历史
		const stepMessage = await result.response;
		messages.push(...stepMessage.messages);

		// 退出条件：模型没有调用任何工具，说明它认为可以直接回复了
		if (!hasTollCall) {
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
