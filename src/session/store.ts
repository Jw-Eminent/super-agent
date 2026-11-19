import {
	existsSync,
	mkdirSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';

const SESSION_DIR = '.sessions';

export interface SessionEntry {
	type: 'message';
	timestamp: string;
	message: ModelMessage;
}

export class SessionStore {
	private dir: string;
	private sessionId: string;

	constructor(sessionId: string = 'default') {
		this.sessionId = sessionId;
		this.dir = SESSION_DIR;
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
	}

	private get filePath(): string {
		return join(this.dir, `${this.sessionId}.jsonl`);
	}

	append(message: ModelMessage): void {
		const entry: SessionEntry = {
			type: 'message',
			timestamp: new Date().toISOString(),
			message,
		};
		appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
	}

	appendAll(messages: ModelMessage[]): void {
		for (const msg of messages) {
			this.append(msg);
		}
	}

	/** 新会话启动时清空历史文件 */
	clear(): void {
		writeFileSync(this.filePath, '', 'utf-8');
	}

	/** 压缩改写整段历史后覆盖写盘 */
	replaceAll(messages: ModelMessage[]): void {
		const body = messages
			.map((message) =>
				JSON.stringify({
					type: 'message',
					timestamp: new Date().toISOString(),
					message,
				} satisfies SessionEntry),
			)
			.join('\n');
		writeFileSync(this.filePath, body ? body + '\n' : '', 'utf-8');
	}

	load(): ModelMessage[] {
		if (!existsSync(this.filePath)) return [];
		const content = readFileSync(this.filePath, 'utf-8').trim();
		if (!content) return [];

		const messages: ModelMessage[] = [];
		for (const line of content.split('\n')) {
			if (!line.trim()) continue;
			try {
				const entry: SessionEntry = JSON.parse(line);
				if (entry.type === 'message') {
					messages.push(entry.message);
				}
			} catch {
				/* skip malformed lines */
			}
		}
		return messages;
	}

	exists(): boolean {
		return existsSync(this.filePath);
	}
}
