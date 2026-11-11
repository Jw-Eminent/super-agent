/**
 * MCP Client（基于官方 @modelcontextprotocol/sdk）
 *
 * 手写 JSON-RPC 实现备份见：./mcp-client.manual.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface MCPTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

function mergeEnv(extra?: Record<string, string>): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) base[key] = value;
	}
	return { ...base, ...extra };
}

export class MCPClient {
	private client: Client | null = null;
	private transport: StdioClientTransport | null = null;
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
		this.transport = new StdioClientTransport({
			command: this.command,
			args: this.args,
			env: mergeEnv(this.env),
			stderr: 'pipe',
		});

		this.client = new Client({
			name: 'super-agent',
			version: '0.5.0',
		});

		await this.client.connect(this.transport);
	}

	async listTools(): Promise<MCPTool[]> {
		if (!this.client) throw new Error('MCP client not connected');
		const result = await this.client.listTools();
		return (result.tools || []).map((tool) => ({
			name: tool.name,
			description: tool.description || '',
			inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
		}));
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this.client) throw new Error('MCP client not connected');
		const result = await this.client.callTool({ name, arguments: args });
		const content = Array.isArray(result.content) ? result.content : [];
		const texts = content
			.filter(
				(c): c is { type: 'text'; text: string } =>
					c !== null &&
					typeof c === 'object' &&
					'type' in c &&
					(c as { type: string }).type === 'text' &&
					typeof (c as { text?: unknown }).text === 'string',
			)
			.map((c) => c.text);
		return texts.join('\n') || '(无返回内容)';
	}

	async close(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = null;
		}
		this.transport = null;
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
