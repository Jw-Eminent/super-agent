/**
 * 手写 MCP Client 备份（JSON-RPC over stdio）
 *
 * 当前生效实现见：./mcp-client.ts（基于 @modelcontextprotocol/sdk）
 * 如需回退，把本文件内容拷回 mcp-client.ts 即可。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

interface MCPTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

export class MCPClient {
	private process: ChildProcess | null = null;
	private rl: Interface | null = null;
	private requestId = 0;
	private pending = new Map<
		number,
		{
			resolve: (v: any) => void;
			reject: (e: Error) => void;
		}
	>();
	private serverName: string;

	constructor(
		private command: string,
		private args: string[],
		private env?: Record<string, string>,
	) {
		this.serverName =
			args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
	}

	async connect(): Promise<void> {
		// 启动一个 MCP Server 子进程，并把它的输入输出接到管道上，以便我们能够读取和写入数据
		this.process = spawn(this.command, this.args, {
			// 如果写成默认/inherit（接到终端）：

			// MCP Server 打印 JSON
			//         ↓
			// 直接出现在你的终端屏幕上
			// 父进程（MCPClient）→ 拿不到这些数据

			// 父进程 MCPClient                子进程 MCP Server
			// ─────────────────              ─────────────────
			// stdin.write(请求)  ──pipe──►   读到请求
			// 读 stdout         ◄──pipe──   写出响应 JSON
			// 读 stderr         ◄──pipe──   写出错误日志
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...this.env },
		});

		this.process.on('error', (err) => {
			console.error(`  [MCP] 进程启动失败: ${err.message}`);
		});
		this.process.stderr?.on('data', () => {});
		// 创建一个 readline 接口，以便我们能够读取 MCP Server 的输出; 用 Node 的 readline，把 MCP 子进程的标准输出按「一行一行」读出来
		this.rl = createInterface({ input: this.process.stdout! });
		this.rl.on('line', (line) => {
			try {
				const msg = JSON.parse(line);
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) {
						p.reject(
							new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
						);
					} else {
						p.resolve(msg.result);
					}
				}
			} catch {
				/* ignore non-JSON lines */
			}
		});
		// MCP 握手的第一步：告诉 Server「我是谁、用哪版协议」，等它确认后才能调工具。
		await this.send('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'super-agent', version: '0.5.0' },
		});

		// MCP 握手的第二步：告诉 Server「我准备好了」，Server 确认后会开始发消息。
		this.process.stdin!.write(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			}) + '\n',
		);
	}

	// 写一条带递增 id 的 JSON-RPC 请求，等待响应; 15s 超时；成功 resolve(result)，失败 reject(error)
	private send(method: string, params?: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++this.requestId;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request timeout: ${method}`));
			}, 15000);

			this.pending.set(id, {
				resolve: (v: any) => {
					clearTimeout(timeout);
					resolve(v);
				},
				reject: (e: Error) => {
					clearTimeout(timeout);
					reject(e);
				},
			});

			const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
			this.process!.stdin!.write(msg + '\n');
		});
	}

	async listTools(): Promise<MCPTool[]> {
		const result = await this.send('tools/list', {});
		return result.tools || [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const result: MCPCallResult = await this.send('tools/call', {
			name,
			arguments: args,
		});
		const texts = (result.content || [])
			.filter((c) => c.type === 'text' && c.text)
			.map((c) => c.text!);
		return texts.join('\n') || '(无返回内容)';
	}

	async close(): Promise<void> {
		if (this.rl) this.rl.close();
		if (this.process) this.process.kill();
	}
}

export class MockMCPClient {
	async connect(): Promise<void> {}

	async listTools(): Promise<MCPTool[]> {
		return [
			{
				name: 'list_issues',
				description: '列出 GitHub 仓库的 Issues',
				inputSchema: {
					type: 'object',
					properties: {
						owner: { type: 'string', description: '仓库所有者' },
						repo: { type: 'string', description: '仓库名称' },
					},
					required: ['owner', 'repo'],
				},
			},
			{
				name: 'search_repositories',
				description: '搜索 GitHub 仓库',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: '搜索关键词' },
					},
					required: ['query'],
				},
			},
			{
				name: 'get_file_contents',
				description: '获取仓库中文件的内容',
				inputSchema: {
					type: 'object',
					properties: {
						owner: { type: 'string', description: '仓库所有者' },
						repo: { type: 'string', description: '仓库名称' },
						path: { type: 'string', description: '文件路径' },
					},
					required: ['owner', 'repo', 'path'],
				},
			},
		];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		switch (name) {
			case 'list_issues':
				return JSON.stringify(
					[
						{ number: 42, title: '支持 MCP 协议接入', state: 'open' },
						{ number: 41, title: '循环检测阈值可配置化', state: 'open' },
						{
							number: 39,
							title: 'Token 预算用完后的优雅降级',
							state: 'closed',
						},
					],
					null,
					2,
				);
			case 'search_repositories':
				return JSON.stringify(
					[
						{ full_name: 'anthropics/anthropic-sdk-python', stars: 2800 },
						{ full_name: 'vercel/ai', stars: 12000 },
						{ full_name: 'modelcontextprotocol/servers', stars: 5600 },
					],
					null,
					2,
				);
			case 'get_file_contents':
				return `# README\n\nMock file: ${args.owner}/${args.repo}/${args.path}`;
			default:
				return `未知工具: ${name}`;
		}
	}

	async close(): Promise<void> {}
}
