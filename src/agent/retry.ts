// --- 错误分类 ---

export function isRetryable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message || '';

	// HTTP 状态码判断
	const statusMatch = message.match(/(\d{3})/);
	if (statusMatch) {
		const status = parseInt(statusMatch[1]);
		if ([429, 529, 408].includes(status)) return true;
		if (status >= 500 && status < 600) return true;
		if (status >= 400 && status < 500) return false;
	}

	// 网络错误
	if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
	if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
	if (message.includes('fetch failed') || message.includes('network'))
		return true;
	// AI SDK 会把流式错误包装成 NoOutputGeneratedError
	if (message.includes('No output generated')) return true;

	return false;
}

// --- 指数退避 + 随机抖动 ---
// 为什么要这样：如果很多请求同时失败、又都等完全一样的时间再重试，会一起再撞上限流；各自稍微错开一点，压力就分散了
export function calculateDelay(
	attempt: number,
	baseMs = 500,
	maxMs = 30000,
): number {
	const exponential = baseMs * Math.pow(2, attempt - 1);
	const capped = Math.min(exponential, maxMs);
	const jitterRange = capped * 0.25; // 抖动范围为 +/- 25%   先算出抖动范围capped的25%
	const jittered = capped + (Math.random() * 2 - 1) * jitterRange; // 随机一个抖动值，然后加上去， Math.random() 返回 0-1 之间的随机数， * 2 - 1 返回 -1-1 之间的随机数
	return Math.max(0, Math.round(jittered));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
