import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.dirname(scriptDirectory);
const configPath = path.join(repositoryDirectory, 'config.json');
const outputPath = path.join(repositoryDirectory, 'data', 'feed_complete.json');
const modelOutputArtifactPath = path.join(repositoryDirectory, 'data', 'ai_model_output.txt');
const SAFE_LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const SAFE_LOG_VALUE_LIMIT = 512;
const MAX_MODEL_OUTPUT_ARTIFACT_BYTES = 2 * 1024 * 1024;
// Preserve the complete received SSE/JSON response for the downloadable
// diagnostic artifact. The stream reader already rejects responses above 20 MiB.
const RAW_RESPONSE_CAPTURE_LIMIT = 20 * 1024 * 1024;
const RAW_LOG_CHUNK_CHARS = 6_000;
const MAX_AI_INPUT_POSTS = 150;
let emittedLogBytes = 0;
let logLimitReported = false;
let modelOutputArtifactInitialized = false;
let modelOutputArtifactTruncated = false;

const NVIDIA_MODEL_SPECS = Object.freeze({
    'minimaxai/minimax-m3': Object.freeze({ temperature: 1, top_p: 0.95, max_tokens: 8192, stream: false }),
});

function sanitizeLogText(value, limit = SAFE_LOG_VALUE_LIMIT, options = {}) {
    let text = String(value ?? '')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|key|nvapi)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
        .replace(/([?&](?:api_?key|apikey|key|token|access_token|auth|authorization|secret)=)[^&#\s]*/gi, '$1[redacted]');
    if (options.redactUrls !== false) {
        text = text.replace(/https?:\/\/[^\s)\]}>,]+/gi, '[url]');
    }
    for (const secretName of ['OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'XBANGDAN_API_URL']) {
        const secret = String(process.env[secretName] || '');
        for (const valuePart of secret.split(/\r?\n/).map(part => part.trim()).filter(part => part.length >= 8)) {
            text = text.split(valuePart).join('[redacted]');
        }
    }
    if (text.length > limit) text = `${text.slice(0, limit)}…[truncated]`;
    return text;
}

function redactSensitiveModelOutput(value) {
    let text = String(value ?? '');
    const findings = new Set();
    const replace = (pattern, type, replacement) => {
        text = text.replace(pattern, (...args) => {
            findings.add(type);
            return typeof replacement === 'function' ? replacement(...args) : replacement;
        });
    };

    for (const secretName of ['OPENROUTER_API_KEY', 'NVIDIA_API_KEY']) {
        const secret = String(process.env[secretName] || '');
        for (const part of secret.split(/\r?\n/).map(item => item.trim()).filter(item => item.length >= 8)) {
            if (text.includes(part)) {
                findings.add('api_key_exact');
                text = text.split(part).join('[REDACTED_API_KEY]');
            }
        }
    }
    const configuredApiUrl = String(process.env.XBANGDAN_API_URL || '').trim();
    if (configuredApiUrl.length >= 8 && text.includes(configuredApiUrl)) {
        findings.add('api_url_exact');
        text = text.split(configuredApiUrl).join('[REDACTED_API_URL]');
    }

    replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'bearer_token', 'Bearer [REDACTED]');
    replace(/\b(?:sk|key|nvapi)-[A-Za-z0-9_-]{12,}\b/gi, 'api_key_pattern', '[REDACTED_API_KEY]');
    replace(/((?:api[_-]?key|access[_-]?token|authorization|secret)\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi,
        'credential_assignment', (_match, prefix) => `${prefix}[REDACTED]`);
    replace(/((?:api[_-]?url)\s*[:=]\s*)(https?:\/\/[^\s"'<>]+)/gi,
        'api_url_assignment', (_match, prefix) => `${prefix}[REDACTED_API_URL]`);
    replace(/([?&](?:api_?key|apikey|key|token|access_token|auth|authorization|secret)=)[^&#\s]*/gi,
        'url_credential', (_match, prefix) => `${prefix}[REDACTED]`);

    return { text, findings: [...findings].sort() };
}

function initializeModelOutputArtifact() {
    const header = [
        'Sanitized AI request and model output',
        `generated_at: ${new Date().toISOString()}`,
        'security: exact configured API keys/API URL and common credential patterns are redacted',
        '',
    ].join('\n');
    writeAtomic(modelOutputArtifactPath, header);
    modelOutputArtifactInitialized = true;
    modelOutputArtifactTruncated = false;
}

function utf8Prefix(value, maxBytes) {
    if (maxBytes <= 0) return '';
    let bytes = 0;
    let end = 0;
    for (const character of String(value)) {
        const characterBytes = Buffer.byteLength(character);
        if (bytes + characterBytes > maxBytes) break;
        bytes += characterBytes;
        end += character.length;
    }
    return String(value).slice(0, end);
}

function appendModelOutputArtifactSection(section) {
    if (!modelOutputArtifactInitialized || modelOutputArtifactTruncated) return;
    const currentBytes = fs.statSync(modelOutputArtifactPath).size;
    const remainingBytes = MAX_MODEL_OUTPUT_ARTIFACT_BYTES - currentBytes;
    if (remainingBytes <= 0) {
        modelOutputArtifactTruncated = true;
        return;
    }
    const sectionBytes = Buffer.byteLength(section);
    if (sectionBytes <= remainingBytes) {
        fs.appendFileSync(modelOutputArtifactPath, section, 'utf8');
        return;
    }
    const marker = `\n[artifact truncated at ${MAX_MODEL_OUTPUT_ARTIFACT_BYTES} bytes]\n`;
    const markerBytes = Buffer.byteLength(marker);
    const prefix = utf8Prefix(section, Math.max(0, remainingBytes - markerBytes));
    const markerSpace = remainingBytes - Buffer.byteLength(prefix);
    fs.appendFileSync(modelOutputArtifactPath, `${prefix}${utf8Prefix(marker, markerSpace)}`, 'utf8');
    modelOutputArtifactTruncated = true;
}

function appendModelRequestArtifact({ provider, modelId, attempt, headers, body }) {
    if (!modelOutputArtifactInitialized) return;
    const request = JSON.stringify({
        method: 'POST',
        url: '[REDACTED_API_URL]',
        headers: {
            authorization: 'Bearer [REDACTED_API_KEY]',
            ...headers,
        },
        body,
    }, null, 2);
    const sanitized = redactSensitiveModelOutput(request);
    const section = [
        '================================================================================',
        'record_type: request',
        `provider: ${sanitizeLogText(provider, 64, { redactUrls: false })}`,
        `model: ${sanitizeLogText(modelId, 256, { redactUrls: false })}`,
        `attempt: ${Number(attempt) || 1}`,
        `captured_at: ${new Date().toISOString()}`,
        `request_chars: ${sanitized.text.length}`,
        `sensitive_values_detected: ${sanitized.findings.length > 0 ? 'yes' : 'no'}`,
        `redaction_types: ${sanitized.findings.join(', ') || 'pre-redacted headers and API URL only'}`,
        '--- request ---',
        sanitized.text,
        '',
    ].join('\n');
    appendModelOutputArtifactSection(section);
}

function appendModelOutputArtifact({ provider, modelId, attempt, content, response }) {
    if (!modelOutputArtifactInitialized) return;
    const sanitized = redactSensitiveModelOutput(content);
    const rawResponse = String(response?.rawResponse || '');
    const sanitizedRawResponse = redactSensitiveModelOutput(rawResponse);
    const redactionTypes = [...new Set([...sanitized.findings, ...sanitizedRawResponse.findings])].sort();
    const isError = Boolean(response?.errorCode);
    const section = [
        '================================================================================',
        'record_type: response',
        `provider: ${sanitizeLogText(provider, 64, { redactUrls: false })}`,
        `model: ${sanitizeLogText(modelId, 256, { redactUrls: false })}`,
        `attempt: ${Number(attempt) || 1}`,
        `captured_at: ${new Date().toISOString()}`,
        `finish_reason: ${sanitizeLogText(response?.finishReason || 'unknown', 64)}`,
        `status: ${Number(response?.status) || 0}`,
        `error_code: ${sanitizeLogText(response?.errorCode || 'none', 96)}`,
        `error_message: ${sanitizeLogText(response?.errorMessage || 'none', 512, { redactUrls: false })}`,
        `output_chars: ${String(content ?? '').length}`,
        `response_bytes: ${Number(response?.responseBytes) || 0}`,
        `raw_response_chars: ${rawResponse.length}`,
        `prompt_tokens: ${Number(response?.promptTokens) || 0}`,
        `completion_tokens: ${Number(response?.completionTokens) || 0}`,
        `api_output_truncated: ${response?.finishReason === 'length' ? 'yes' : 'no'}`,
        `raw_response_capture_truncated: ${rawResponse.includes('[raw response capture truncated]') ? 'yes' : 'no'}`,
        `sensitive_values_detected: ${redactionTypes.length > 0 ? 'yes' : 'no'}`,
        `redaction_types: ${redactionTypes.join(', ') || 'none'}`,
        '--- output ---',
        sanitized.text || '(no visible model output received)',
        ...(isError ? [
            '--- raw response/error body ---',
            sanitizedRawResponse.text || '(no response body received)',
        ] : []),
        '',
    ].join('\n');
    appendModelOutputArtifactSection(section);
}

function appendModelFailureArtifact({ provider, modelId, attempt, failure }) {
    if (failure?.responseArtifactRecorded) return;
    appendModelOutputArtifact({
        provider,
        modelId: failure?.model || modelId,
        attempt,
        content: failure?.content || '',
        response: {
            ...failure,
            errorCode: failure?.code || 'AI_UNKNOWN_ERROR',
            errorMessage: failure?.message || 'unknown error',
        },
    });
    if (failure) failure.responseArtifactRecorded = true;
}

function safeLog(level, phase, event, fields = {}, options = {}) {
    if (emittedLogBytes >= SAFE_LOG_LIMIT_BYTES) {
        if (!logLimitReported) {
            logLimitReported = true;
            console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', phase: 'logging', event: 'LOG_LIMIT_REACHED' }));
        }
        return;
    }
    const safeFields = {};
    const valueLimit = Number(options.valueLimit) || SAFE_LOG_VALUE_LIMIT;
    for (const [key, value] of Object.entries(fields).slice(0, 24)) {
        if (value === undefined || value === null) continue;
        safeFields[key] = typeof value === 'number' || typeof value === 'boolean'
            ? value
            : sanitizeLogText(value, valueLimit, options);
    }
    let line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        phase: sanitizeLogText(phase, 64),
        event: sanitizeLogText(event, 96),
        ...safeFields,
    });
    const remainingBytes = SAFE_LOG_LIMIT_BYTES - emittedLogBytes;
    if (Buffer.byteLength(line) > remainingBytes) {
        line = JSON.stringify({ ts: new Date().toISOString(), level: 'warn', phase: 'logging', event: 'LOG_LIMIT_REACHED' });
        logLimitReported = true;
    }
    emittedLogBytes += Buffer.byteLength(line) + 1;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

function safeRawLog(level, phase, event, fields = {}) {
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        const text = String(value);
        const totalChunks = Math.max(1, Math.ceil(text.length / RAW_LOG_CHUNK_CHARS));
        for (let index = 0; index < totalChunks; index += 1) {
            safeLog(level, phase, event, {
                field: key,
                chunk: index + 1,
                chunks: totalChunks,
                data: text.slice(index * RAW_LOG_CHUNK_CHARS, (index + 1) * RAW_LOG_CHUNK_CHARS),
            }, { valueLimit: RAW_LOG_CHUNK_CHARS, redactUrls: false });
        }
    }
}

function logCompleteModelOutput(level, provider, modelId, content) {
    // The assembled visible answer is the useful artifact for output-format
    // failures. Log it independently from the capped diagnostic stream so a
    // long reasoning trace cannot consume the budget before the answer appears.
    const safeContent = sanitizeLogText(content, Number.MAX_SAFE_INTEGER, { redactUrls: false });
    const totalChunks = Math.max(1, Math.ceil(safeContent.length / RAW_LOG_CHUNK_CHARS));
    for (let index = 0; index < totalChunks; index += 1) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            level,
            phase: 'ai',
            event: 'MODEL_OUTPUT_RAW',
            provider: sanitizeLogText(provider, 64),
            model_id: sanitizeLogText(modelId, 256),
            chunk: index + 1,
            chunks: totalChunks,
            data: safeContent.slice(index * RAW_LOG_CHUNK_CHARS, (index + 1) * RAW_LOG_CHUNK_CHARS),
        });
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    }
}

function logTransportSummary(level, provider, modelId, status, response) {
    safeLog(level, 'ai', 'RESPONSE_TRANSPORT_SUMMARY', {
        provider,
        model_id: modelId || undefined,
        status: status || undefined,
        content_type: response.contentType || undefined,
        response_bytes: response.responseBytes || undefined,
        raw_capture_chars: String(response.rawResponse || '').length || undefined,
        raw_capture_truncated: String(response.rawResponse || '').includes('[raw response capture truncated]'),
    });
}

function writeJobSummary({ status, phase, code, detail, durationMs, topics, posts }) {
    const summaryPath = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
    if (!summaryPath) return;
    const lines = [
        '### Data generation',
        `- Status: ${status}`,
        `- Phase: \`${sanitizeLogText(phase || 'complete', 64)}\``,
        `- Duration: ${Math.round(Number(durationMs) / 1000)}s`,
    ];
    if (code) lines.push(`- Error code: \`${sanitizeLogText(code, 96)}\``);
    if (detail) lines.push(`- Detail: ${sanitizeLogText(detail, 512)}`);
    if (Number.isFinite(topics)) lines.push(`- Topics: ${topics}`);
    if (Number.isFinite(posts)) lines.push(`- Posts: ${posts}`);
    try {
        fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
    } catch {
        safeLog('warn', 'logging', 'SUMMARY_WRITE_FAILED');
    }
}

async function runPhase(phase, action, successFields = () => ({})) {
    const startedAt = Date.now();
    safeLog('info', phase, 'START');
    try {
        const result = await action();
        safeLog('info', phase, 'SUCCESS', { duration_ms: Date.now() - startedAt, ...successFields(result) });
        return result;
    } catch (error) {
        const pipelineError = error instanceof PipelineError ? error : new PipelineError('阶段执行失败', { code: 'UNEXPECTED_ERROR' });
        if (!pipelineError.phase) pipelineError.phase = phase;
        safeLog('error', phase, 'FAILED', {
            code: pipelineError.code,
            duration_ms: Date.now() - startedAt,
            retryable: pipelineError.retryable,
            status: pipelineError.status || undefined,
            detail: pipelineError.message,
        });
        throw pipelineError;
    }
}

const SYSTEM_PROMPT = `你是中文社交媒体热点榜单编辑。只完成聚类并输出结果，不解释思路。

唯一允许的输出格式（每个话题一行）：
浓缩标题----文章ID1,文章ID2----#标签1,#标签2,#标签3

正确示例（ID 仅演示格式，禁止照抄）：
某公司回应产品争议----123456789012345678,223456789012345678----#公司,#产品,#争议

错误示例：
某公司回应产品争议--123456789012345678,223456789012345678--#公司,#产品,#争议（分隔符不是四个短横线）
某公司回应产品争议----123456789012345678----#公司,#产品,#争议（只有一个 ID）
以下是结果：……（包含解释或前言）

硬性规则：
1. 每行恰好三个字段、恰好两个“----”；标题本身不得含“----”。不要输出 Markdown、序号、前言、结语或代码围栏。
2. ID 必须完整复制自输入，用英文逗号分隔；每组至少 2 个 ID；同一 ID 最多出现一次。禁止猜测、缩写或重新编号。
3. 只合并具有明确共同锚点（人物、公司、产品、事件、争议或持续叙事）的帖子。仅领域相同、相邻、热门或词语相似不得合并；不确定就不输出该帖子。
4. 标题是对热门内容的观点性缩略，应保留核心观点、冲突、质疑或进展。优先参考曝光量高且信息完整的帖子，但不得因此合并无关帖子。
5. 禁止使用“话题讨论”“相关动态”“引发关注”“网友热议”“持续发酵”等空泛标题，也不要把尖锐观点改成中立分类或把观点写成已证实事实。
6. 标题使用自然中文，建议 12 至 36 个汉字；每组给 3 至 8 个以 # 开头的具体标签。
7. 不要自行排序，程序会排序。

输出前逐行自检：必须有两个且仅两个“----”；中间至少两个真实输入 ID；末尾至少三个标签；整行没有任何额外说明。`;

class PipelineError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'PipelineError';
        this.code = String(options.code || 'PIPELINE_ERROR');
        this.phase = String(options.phase || '');
        this.retryable = options.retryable === true;
        this.status = Number(options.status) || 0;
        this.model = String(options.model || '');
        this.finishReason = String(options.finishReason || '');
        this.responseBytes = Number(options.responseBytes) || 0;
        this.promptTokens = Number(options.promptTokens) || 0;
        this.completionTokens = Number(options.completionTokens) || 0;
        this.contentChars = Number(options.contentChars) || 0;
        this.reasoningChars = Number(options.reasoningChars) || 0;
        this.reasoningTokens = Number(options.reasoningTokens) || 0;
        this.contentType = String(options.contentType || '');
        this.content = String(options.content || '');
        this.rawResponse = String(options.rawResponse || '');
        this.parsedTopics = Number(options.parsedTopics) || 0;
        this.networkCode = String(options.networkCode || '');
        this.responseArtifactRecorded = options.responseArtifactRecorded === true;
    }
}

function readConfig() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw new PipelineError(`配置文件无法读取：${error.message}`, { code: 'CONFIG_READ_ERROR' });
    }
    const requiredNumberFields = ['temperature', 'top_p', 'max_tokens', 'minimum_topics', 'openrouter_request_timeout_ms', 'nvidia_request_timeout_ms', 'stream_idle_timeout_ms', 'overall_task_timeout_ms'];
    for (const field of requiredNumberFields) {
        if (!Number.isFinite(Number(config[field]))) throw new PipelineError(`配置项 ${field} 必须是数字`, { code: 'CONFIG_INVALID' });
    }
    if (config.ai_api !== 'https://openrouter.ai/api/v1/chat/completions') {
        throw new PipelineError('ai_api 必须使用 OpenRouter 官方 chat/completions 地址');
    }
    if (config.nvidia_api !== 'https://integrate.api.nvidia.com/v1/chat/completions') {
        throw new PipelineError('nvidia_api 必须使用 NVIDIA 官方 chat/completions 地址');
    }
    if (String(config.openrouter_model || '') !== 'minimax/minimax-m3:free') {
        throw new PipelineError('openrouter_model 必须固定为 minimax/minimax-m3:free', { code: 'CONFIG_INVALID' });
    }
    if (!NVIDIA_MODEL_SPECS[String(config.nvidia_fallback_model || '')]) {
        throw new PipelineError('nvidia_fallback_model 当前只支持 minimaxai/minimax-m3', { code: 'CONFIG_INVALID' });
    }
    if (!Number.isInteger(Number(config.minimum_topics)) || Number(config.minimum_topics) < 1 || Number(config.minimum_topics) > 15) {
        throw new PipelineError('minimum_topics 必须是 1 到 15 的整数');
    }
    if (Number(config.max_tokens) < 1
        || Number(config.openrouter_request_timeout_ms) < 1_000 || Number(config.openrouter_request_timeout_ms) > 1_200_000
        || Number(config.nvidia_request_timeout_ms) < 1_000 || Number(config.nvidia_request_timeout_ms) > 1_200_000
        || Number(config.stream_idle_timeout_ms) < 1_000 || Number(config.stream_idle_timeout_ms) > 600_000
        || Number(config.overall_task_timeout_ms) < 60_000 || Number(config.overall_task_timeout_ms) > 1_500_000) {
        throw new PipelineError('模型输出上限、超时或整体任务超出允许范围');
    }
    return config;
}

function readSecret(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new PipelineError(`缺少 Repository secret：${name}`, { code: 'SECRET_MISSING' });
    return value;
}

function readSecretLines(name) {
    return [...new Set(readSecret(name).split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
}

function shuffle(values) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
        const target = crypto.randomInt(index + 1);
        [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
}

function readApiKeys() {
    const keys = [...new Set(readSecret('OPENROUTER_API_KEY').split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    if (!keys.length) throw new PipelineError('OPENROUTER_API_KEY 中没有可用 Key');
    return shuffle(keys);
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        const reason = error?.name === 'AbortError' ? '请求超时' : '网络请求失败';
        throw new PipelineError(`${label}${reason}`, {
            code: error?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR',
            retryable: true,
        });
    } finally {
        clearTimeout(timer);
    }
}

function validateFeed(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.rate) || !Array.isArray(data.views)) {
        throw new PipelineError('上游数据必须包含 rate 和 views 数组');
    }
    if (!data.rate.length && !data.views.length) throw new PipelineError('上游榜单为空');
    delete data.attribution;
    return data;
}

async function downloadFeed(sourceUrl) {
    const response = await fetchWithTimeout(sourceUrl, {
        headers: {
            accept: 'application/json',
            'user-agent': 'ai-data-server/1.0',
        },
        redirect: 'follow',
    }, 30_000, '上游数据');
    if (!response.ok) throw new PipelineError(`上游数据返回 HTTP ${response.status}`, { code: `UPSTREAM_HTTP_${response.status}` });
    let data;
    try {
        data = await response.json();
    } catch {
        throw new PipelineError('上游数据不是合法 JSON', { code: 'UPSTREAM_INVALID_JSON' });
    }
    return validateFeed(data);
}

function cleanText(value) {
    return String(value || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[\t\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractEntries(feed) {
    const byId = new Map();
    for (const item of [...feed.rate, ...feed.views]) {
        const id = String(item?.id || '');
        if (!/^\d{5,25}$/.test(id)) continue;
        const previous = byId.get(id);
        byId.set(id, previous ? {
            ...previous,
            ...item,
            id,
            v: Math.max(Number(previous.v) || 0, Number(item.v) || 0),
            r: Math.max(Number(previous.r) || 0, Number(item.r) || 0),
            l: Math.max(Number(previous.l) || 0, Number(item.l) || 0),
        } : { ...item, id });
    }
    const entries = [...byId.values()]
        .map(item => ({ item, text: cleanText(item.t) }))
        .filter(entry => entry.text)
        .sort((a, b) => ((Number(b.item.v) || 0) - (Number(a.item.v) || 0)) || ((Number(b.item.r) || 0) - (Number(a.item.r) || 0)))
        .slice(0, MAX_AI_INPUT_POSTS)
        .map((entry, position) => ({
            index: position + 1,
            id: String(entry.item.id),
            text: entry.text,
            raw: entry.item,
        }));
    if (entries.length < 2) throw new PipelineError('上游数据中可供聚类的有效推文不足 2 条');
    return entries;
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
    }
    return '';
}

function createAiDispatcher(timeoutMs) {
    const timeout = Math.max(1_000, Number(timeoutMs));
    return new Agent({
        headersTimeout: timeout,
        bodyTimeout: timeout,
        connectTimeout: timeout,
    });
}

async function readOpenRouterStream(response, timeoutMs, controller, providerName = 'OpenRouter') {
    if (!response.body) throw new PipelineError(`${providerName} 没有返回响应流`, { code: 'AI_EMPTY_STREAM', retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let model = '';
    let finishReason = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let totalBytes = 0;
    let rawResponse = '';
    let rawResponseTruncated = false;

    const captureRawLine = line => {
        if (rawResponse.length >= RAW_RESPONSE_CAPTURE_LIMIT) {
            rawResponseTruncated = true;
            return;
        }
        const remaining = RAW_RESPONSE_CAPTURE_LIMIT - rawResponse.length;
        if (line.length > remaining) {
            rawResponse += line.slice(0, remaining);
            rawResponseTruncated = true;
        } else {
            rawResponse += line;
        }
    };

    const consumeLine = line => {
        captureRawLine(`${line}\n`);
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(payload);
        } catch {
            throw new PipelineError(`${providerName} 返回了无效 SSE 数据`, { code: 'AI_INVALID_STREAM', retryable: true });
        }
        if (event?.error) throw new PipelineError(`${providerName} 流式响应错误：${String(event.error.code || 'unknown')}`, {
            code: 'AI_STREAM_ERROR',
            retryable: true,
            status: Number(event.error.code) || 0,
        });
        if (event?.model) model = String(event.model);
        if (event?.choices?.[0]?.finish_reason) finishReason = String(event.choices[0].finish_reason);
        if (Number.isFinite(Number(event?.usage?.prompt_tokens))) promptTokens = Number(event.usage.prompt_tokens);
        if (Number.isFinite(Number(event?.usage?.completion_tokens))) completionTokens = Number(event.usage.completion_tokens);
        const choice = event?.choices?.[0];
        const delta = choice?.delta;
        content += contentToText(delta?.content ?? choice?.message?.content);
        reasoningContent += contentToText(delta?.reasoning_content ?? delta?.reasoning ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning);
        if (Number.isFinite(Number(event?.usage?.completion_tokens_details?.reasoning_tokens))) {
            reasoningTokens = Number(event.usage.completion_tokens_details.reasoning_tokens);
        } else if (Number.isFinite(Number(event?.usage?.reasoning_tokens))) {
            reasoningTokens = Number(event.usage.reasoning_tokens);
        }
    };

    try {
        while (true) {
            let timer;
            const chunk = await Promise.race([
                reader.read(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new PipelineError(`${providerName} 响应流长时间无数据`, {
                        code: 'AI_STREAM_IDLE_TIMEOUT',
                        retryable: true,
                    })), timeoutMs);
                }),
            ]).finally(() => clearTimeout(timer));
            if (chunk.done) break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > 20 * 1024 * 1024) throw new PipelineError(`${providerName} 响应流过大`, { code: 'AI_STREAM_TOO_LARGE' });
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) consumeLine(line);
        }
        buffer += decoder.decode();
        if (buffer) consumeLine(buffer);
    } catch (error) {
        controller.abort();
        try { await reader.cancel(); } catch (_) {}
        if (error instanceof PipelineError) {
            error.content = content.trim();
            error.contentChars = content.trim().length;
            error.reasoningChars = reasoningContent.trim().length;
            error.finishReason = finishReason;
            error.promptTokens = promptTokens;
            error.completionTokens = completionTokens;
            error.reasoningTokens = reasoningTokens;
            error.rawResponse = rawResponseTruncated ? `${rawResponse}\n[raw response capture truncated]` : rawResponse;
            error.responseBytes = totalBytes;
        }
        throw error;
    } finally {
        reader.releaseLock();
    }
    return {
        content: content.trim(),
        model,
        finishReason,
        responseBytes: totalBytes,
        promptTokens,
        completionTokens,
        contentChars: content.trim().length,
        reasoningChars: reasoningContent.trim().length,
        reasoningTokens,
        rawResponse: rawResponseTruncated ? `${rawResponse}\n[raw response capture truncated]` : rawResponse,
    };
}

async function callOpenRouter(config, apiKey, messages, timeoutMs, attempt = 1) {
    const controller = new AbortController();
    const dispatcher = createAiDispatcher(timeoutMs);
    let totalTimedOut = false;
    let responseContentType = '';
    const totalTimeout = setTimeout(() => {
        totalTimedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const requestHeaders = {
            accept: 'application/json',
            'content-type': 'application/json',
            'http-referer': 'https://github.com/ai-catcher/ai-data-server',
            'x-title': 'ai-data-server',
        };
        const requestBody = {
            model: config.openrouter_model,
            messages,
            temperature: Number(config.temperature),
            top_p: Number(config.top_p),
            max_tokens: Number(config.max_tokens),
            reasoning: { effort: 'low', exclude: true },
            stream: false,
        };
        appendModelRequestArtifact({
            provider: 'openrouter',
            modelId: config.openrouter_model,
            attempt,
            headers: requestHeaders,
            body: requestBody,
        });
        safeRawLog('info', 'ai', 'REQUEST_RAW', {
            provider: 'openrouter',
            url: '[redacted]',
            headers: JSON.stringify(requestHeaders),
            body: JSON.stringify(requestBody),
        });
        const response = await fetch(config.ai_api, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${apiKey}`,
                ...requestHeaders,
            },
            body: JSON.stringify(requestBody),
            dispatcher,
            signal: controller.signal,
        });
        if (!response.ok) {
            const status = response.status;
            const rawResponse = await response.text().catch(() => '');
            const retryable = [401, 403, 408, 409, 429].includes(status) || status >= 500;
            throw new PipelineError(`OpenRouter 返回 HTTP ${status}`, {
                code: `AI_HTTP_${status}`, retryable, status,
                contentType: String(response.headers.get('content-type') || '').toLowerCase(),
                rawResponse,
            });
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        responseContentType = contentType;
        let result;
        if (contentType.includes('text/event-stream')) {
            result = await readOpenRouterStream(response, Number(config.stream_idle_timeout_ms), controller);
            result.contentType = contentType;
        } else {
            let data;
            let rawResponse = '';
            try {
                rawResponse = await response.text();
                data = JSON.parse(rawResponse);
            } catch (error) {
                if (totalTimedOut || error?.name === 'AbortError') throw error;
                throw new PipelineError('OpenRouter 返回了无效 JSON', {
                    code: 'AI_INVALID_RESPONSE', retryable: true, rawResponse,
                    contentType,
                });
            }
            result = {
                content: contentToText(data?.choices?.[0]?.message?.content ?? data?.output_text).trim(),
                model: String(data?.model || ''),
                finishReason: String(data?.choices?.[0]?.finish_reason || ''),
                responseBytes: Buffer.byteLength(JSON.stringify(data)),
                promptTokens: Number(data?.usage?.prompt_tokens) || 0,
                completionTokens: Number(data?.usage?.completion_tokens) || 0,
                contentChars: contentToText(data?.choices?.[0]?.message?.content ?? data?.output_text).trim().length,
                reasoningChars: contentToText(data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning).trim().length,
                reasoningTokens: Number(data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens) || 0,
                contentType,
                rawResponse,
            };
        }
        if (!result.content) {
            throw new PipelineError('OpenRouter 返回空内容', {
                code: 'AI_EMPTY_RESPONSE',
                retryable: true,
                model: result.model,
                finishReason: result.finishReason,
                responseBytes: result.responseBytes,
                promptTokens: result.promptTokens,
                completionTokens: result.completionTokens,
                contentChars: result.contentChars,
                reasoningChars: result.reasoningChars,
                reasoningTokens: result.reasoningTokens,
                contentType: result.contentType,
                rawResponse: result.rawResponse,
            });
        }
        return result;
    } catch (error) {
        let failure;
        if (totalTimedOut || error?.name === 'AbortError') {
            failure = new PipelineError(`OpenRouter 请求超过 ${Math.round(timeoutMs / 1000)} 秒`, {
                code: 'AI_REQUEST_TIMEOUT',
                retryable: true,
                content: error?.content,
                finishReason: error?.finishReason,
                responseBytes: error?.responseBytes,
                promptTokens: error?.promptTokens,
                completionTokens: error?.completionTokens,
                contentChars: error?.contentChars,
                reasoningChars: error?.reasoningChars,
                reasoningTokens: error?.reasoningTokens,
                contentType: error?.contentType || responseContentType,
                rawResponse: error?.rawResponse,
            });
        } else if (error instanceof PipelineError) {
            failure = error;
        } else {
            failure = new PipelineError('OpenRouter 网络请求失败', { code: 'AI_NETWORK_ERROR', retryable: true });
        }
        if (!failure.contentType) failure.contentType = responseContentType;
        appendModelFailureArtifact({ provider: 'openrouter', modelId: config.openrouter_model, attempt, failure });
        throw failure;
    } finally {
        clearTimeout(totalTimeout);
        await dispatcher.close().catch(() => {});
    }
}

async function callNvidia(config, apiKey, modelId, messages, timeoutMs, attempt = 1) {
    const controller = new AbortController();
    const dispatcher = createAiDispatcher(timeoutMs);
    let totalTimedOut = false;
    let responseContentType = '';
    const totalTimeout = setTimeout(() => {
        totalTimedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const modelOptions = getNvidiaModelOptions(modelId);
        const requestHeaders = {
            accept: modelOptions.stream ? 'text/event-stream' : 'application/json',
            'content-type': 'application/json',
        };
        const requestBody = {
            model: modelId,
            messages,
            ...modelOptions,
        };
        appendModelRequestArtifact({
            provider: 'nvidia',
            modelId,
            attempt,
            headers: requestHeaders,
            body: requestBody,
        });
        safeRawLog('info', 'ai', 'REQUEST_RAW', {
            provider: 'nvidia',
            url: '[redacted]',
            headers: JSON.stringify(requestHeaders),
            body: JSON.stringify(requestBody),
        });
        const response = await fetch(config.nvidia_api, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${apiKey}`,
                ...requestHeaders,
            },
            body: JSON.stringify(requestBody),
            dispatcher,
            signal: controller.signal,
        });
        if (!response.ok) {
            const status = response.status;
            const rawResponse = await response.text().catch(() => '');
            throw new PipelineError(`NVIDIA 返回 HTTP ${status}`, {
                code: `AI_HTTP_${status}`, status, model: modelId,
                contentType: String(response.headers.get('content-type') || '').toLowerCase(),
                rawResponse,
            });
        }
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        responseContentType = contentType;
        let result;
        if (contentType.includes('text/event-stream')) {
            result = await readOpenRouterStream(response, Math.min(Number(config.stream_idle_timeout_ms), timeoutMs), controller, 'NVIDIA');
            result.contentType = contentType;
        } else {
            let data;
            let rawResponse = '';
            try {
                rawResponse = await response.text();
                data = JSON.parse(rawResponse);
            } catch (error) {
                if (totalTimedOut || error?.name === 'AbortError') throw error;
                throw new PipelineError('NVIDIA 返回了无效 JSON', {
                    code: 'AI_INVALID_RESPONSE', model: modelId,
                    contentType, rawResponse,
                });
            }
            result = {
                content: contentToText(data?.choices?.[0]?.message?.content ?? data?.output_text).trim(),
                model: String(data?.model || modelId),
                finishReason: String(data?.choices?.[0]?.finish_reason || ''),
                responseBytes: Buffer.byteLength(JSON.stringify(data)),
                promptTokens: Number(data?.usage?.prompt_tokens) || 0,
                completionTokens: Number(data?.usage?.completion_tokens) || 0,
                contentChars: contentToText(data?.choices?.[0]?.message?.content ?? data?.output_text).trim().length,
                reasoningChars: contentToText(data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning).trim().length,
                reasoningTokens: Number(data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens) || 0,
                contentType,
                rawResponse,
            };
        }
        if (!result.content) {
            throw new PipelineError('NVIDIA 返回空内容', {
                code: 'AI_EMPTY_RESPONSE', model: result.model || modelId,
                finishReason: result.finishReason, responseBytes: result.responseBytes,
                promptTokens: result.promptTokens, completionTokens: result.completionTokens,
                contentChars: result.contentChars, reasoningChars: result.reasoningChars,
                reasoningTokens: result.reasoningTokens, contentType: result.contentType,
                rawResponse: result.rawResponse,
            });
        }
        return result;
    } catch (error) {
        let failure;
        if (totalTimedOut || error?.name === 'AbortError') {
            failure = new PipelineError(`NVIDIA 模型 ${modelId} 请求超时`, {
                code: 'AI_REQUEST_TIMEOUT',
                model: modelId,
                content: error?.content,
                finishReason: error?.finishReason,
                responseBytes: error?.responseBytes,
                promptTokens: error?.promptTokens,
                completionTokens: error?.completionTokens,
                contentChars: error?.contentChars,
                reasoningChars: error?.reasoningChars,
                reasoningTokens: error?.reasoningTokens,
                contentType: error?.contentType || responseContentType,
                rawResponse: error?.rawResponse,
            });
        } else if (error instanceof PipelineError) {
            failure = error;
        } else {
            const errorMessage = String(error?.message || '').toLowerCase();
            const networkCode = String(error?.cause?.code || error?.code
                || (errorMessage.includes('invalid header') ? 'INVALID_HEADER_VALUE' : '')
                || (errorMessage.includes('invalid url') ? 'INVALID_URL' : '')
                || (error?.name === 'TypeError' ? 'FETCH_TYPE_ERROR' : '')
                || 'UNKNOWN_NETWORK_ERROR');
            failure = new PipelineError(`NVIDIA 模型 ${modelId} 网络请求失败（${networkCode}）`, {
                code: 'AI_NETWORK_ERROR', model: modelId, networkCode,
            });
        }
        if (!failure.model) failure.model = modelId;
        if (!failure.contentType) failure.contentType = responseContentType;
        appendModelFailureArtifact({ provider: 'nvidia', modelId, attempt, failure });
        throw failure;
    } finally {
        clearTimeout(totalTimeout);
        await dispatcher.close().catch(() => {});
    }
}

function getNvidiaModelOptions(modelId) {
    const spec = NVIDIA_MODEL_SPECS[modelId];
    if (!spec) throw new PipelineError('NVIDIA 兜底模型不在允许列表中', { code: 'MODEL_NOT_ALLOWED', model: modelId });
    return {
        ...spec,
        ...(spec.chat_template_kwargs ? { chat_template_kwargs: { ...spec.chat_template_kwargs } } : {}),
    };
}

function parseTags(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,，、\s]+/);
    return values
        .map(tag => String(tag || ''))
        .map(tag => tag.trim())
        .filter(Boolean)
        .map(tag => tag.startsWith('#') ? tag : `#${tag}`)
        .slice(0, 8);
}

function splitPlainTextFields(line) {
    const exactFields = line.split('----');
    if (exactFields.length === 3) return exactFields;
    if (line.includes('----')) return null;
    if ((line.match(/--/g) || []).length !== 2) return null;

    // Some models emit two dashes despite an explicit four-dash contract.
    // Accept only the unambiguous shape: exactly two delimiters and at least
    // two numeric IDs in the middle. This rejects single-ID and concatenated rows.
    const tolerantMatch = line.match(/^(.+?)--(\d{5,25}(?:\s*[,，、]\s*\d{5,25})+)--(.+)$/);
    return tolerantMatch ? tolerantMatch.slice(1) : null;
}

function parsePlainTextTopics(rawText, entries, minimumTopics) {
    const entryMap = new Map(entries.map(entry => [entry.id, entry]));
    const assigned = new Map();
    const groups = [];
    const lines = String(rawText || '').split(/\r?\n/);
    for (const line of lines) {
        const fields = splitPlainTextFields(line.trim());
        if (!fields) continue;
        const title = [...fields[0].trim()].slice(0, 60).join('');
        if (title.length < 1) continue;
        const ids = [...new Set(fields[1].split(/[,，、\s]+/).map(value => value.trim()).filter(Boolean))];
        if (ids.length < 1 || !ids.every(id => /^\d{5,25}$/.test(id))) continue;
        const items = ids.map(id => entryMap.get(id));
        if (items.some(item => !item) || items.some(item => assigned.has(item.index))) continue;
        const parsedTags = parseTags(fields[2]);
        if (parsedTags.length < 1) continue;
        const tags = parseTags([...parsedTags, '#热点话题', '#X热帖', '#AI整理']);
        for (const item of items) assigned.set(item.index, title);
        groups.push({ title, tags, items });
    }
    if (groups.length < minimumTopics) {
        throw new PipelineError(`AI 输出仅解析出 ${groups.length} 个有效纯文本话题`, {
            code: 'AI_OUTPUT_VALIDATION_FAILED',
            retryable: true,
            parsedTopics: groups.length,
        });
    }
    return { groups, assigned };
}

function parseAIOutput(text, entries, minimumTopics) {
    const entryMap = new Map(entries.map(entry => [entry.index, entry]));
    const assigned = new Map();
    const groups = [];
    let rawText = String(text || '').trim();
    if (rawText.startsWith('```') && rawText.endsWith('```')) {
        rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    let output;
    try {
        output = JSON.parse(rawText);
    } catch {
        return parsePlainTextTopics(rawText, entries, minimumTopics);
    }
    if (!output || typeof output !== 'object' || !Array.isArray(output.topics)) {
        throw new PipelineError('AI 输出不符合 topics JSON 结构', { code: 'AI_OUTPUT_VALIDATION_FAILED', retryable: true });
    }

    for (const topic of output.topics) {
        if (!topic || typeof topic !== 'object') continue;
        const title = [...String(topic.title || '').trim()].slice(0, 60).join('');
        if (title.length < 1) continue;
        if (!Array.isArray(topic.indices) || !topic.indices.every(Number.isInteger)) continue;
        const indices = [...new Set(topic.indices)];
        const items = indices.map(index => entryMap.get(index));
        if (items.length < 1 || items.some(item => !item) || items.some(item => assigned.has(item.index))) continue;
        const parsedTags = parseTags(topic.tags);
        if (parsedTags.length < 1) continue;
        const tags = parseTags([...parsedTags, '#热点话题', '#X热帖', '#AI整理']);
        for (const item of items) assigned.set(item.index, title);
        groups.push({ title, tags, items });
    }

    if (groups.length < minimumTopics) {
        throw new PipelineError(`AI 输出仅解析出 ${groups.length} 个有效话题`, {
            code: 'AI_OUTPUT_VALIDATION_FAILED',
            retryable: true,
            parsedTopics: groups.length,
        });
    }
    return { groups, assigned };
}

function formatNumber(value) {
    const number = Number(value) || 0;
    if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(1)}亿`;
    if (number >= 10_000) return `${(number / 10_000).toFixed(1)}万`;
    return String(Math.round(number));
}

function pickSamples(items) {
    const sorted = [...items].sort((a, b) => (Number(b.raw.v) || 0) - (Number(a.raw.v) || 0));
    const selected = [];
    const handles = new Set();
    for (const item of sorted) {
        const handle = String(item.raw.h || '').toLowerCase();
        if (handles.has(handle)) continue;
        selected.push(item);
        handles.add(handle);
        if (selected.length === 3) return selected;
    }
    for (const item of sorted) {
        if (!selected.includes(item)) selected.push(item);
        if (selected.length === 3) break;
    }
    return selected;
}

function singletonTitle(item) {
    const text = cleanText(item.raw.t).replace(/^RT\s+@\w+:\s*/i, '');
    const firstSentence = text.split(/[。！？!?；;]/, 1)[0].trim() || text;
    const title = [...firstSentence].slice(0, 30).join('').trim();
    if (title.length >= 5) return title;
    return `${[...(String(item.raw.n || item.raw.h || '用户'))].slice(0, 20).join('')}发布热门内容`;
}

function singletonTags(item) {
    const tags = [...String(item.raw.t || '').matchAll(/#[\p{L}\p{N}_-]+/gu)].map(match => match[0]);
    const category = String(item.raw.c || '').trim();
    if (category && category !== 'none') tags.push(`#${category}`);
    tags.push('#独立话题', '#X热帖');
    return [...new Set(tags)].slice(0, 8);
}

function buildTopics(entries, parsed) {
    const unmatched = entries.filter(entry => !parsed.assigned.has(entry.index));
    const allGroups = [
        ...parsed.groups,
        ...unmatched.map(item => ({ title: singletonTitle(item), tags: singletonTags(item), items: [item] })),
    ];
    const topics = allGroups.map(group => {
        const totalViews = group.items.reduce((sum, item) => sum + (Number(item.raw.v) || 0), 0);
        const totalLikes = group.items.reduce((sum, item) => sum + (Number(item.raw.l) || 0), 0);
        const maxRate = Math.max(...group.items.map(item => Number(item.raw.r) || 0));
        const people = new Set(group.items.map(item => String(item.raw.h || '').toLowerCase())).size;
        const values = group.items.map(item => Number(item.raw.v) || 0).sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        const medianViews = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
        return {
            title: group.title,
            meta: `${group.items.length} 帖 · ${people} 人在说 · ${formatNumber(totalViews)}曝光`,
            median: `中位数 ${formatNumber(medianViews)} 曝光`,
            views: formatNumber(totalViews),
            stats: {
                posts: group.items.length,
                people,
                total_views: totalViews,
                median_views: medianViews,
                total_likes: totalLikes,
                max_rate: maxRate,
            },
            tags: group.tags,
            samples: pickSamples(group.items).map(item => ({
                id: item.id,
                url: `https://x.com/${String(item.raw.h || '').replace(/^@/, '')}/status/${item.id}`,
                text: String(item.raw.t || ''),
                handle: `@${String(item.raw.h || '').replace(/^@/, '')}`,
                name: String(item.raw.n || item.raw.h || ''),
                views: formatNumber(item.raw.v),
                raw_views: Number(item.raw.v) || 0,
            })),
            source_ids: group.items.map(item => item.id),
            source_indices: group.items.map(item => item.index),
            searchUrl: `https://x.com/search?q=${encodeURIComponent(group.title)}&src=typed_query&f=live`,
        };
    });
    topics.sort((a, b) => {
        const multiPostDifference = Number(b.stats.posts > 1) - Number(a.stats.posts > 1);
        if (multiPostDifference !== 0) return multiPostDifference;
        return b.stats.total_views - a.stats.total_views;
    });
    topics.forEach((topic, index) => { topic.rank = index + 1; });
    return {
        topics,
        unmatched: {
            count: unmatched.length,
            source_ids: unmatched.map(entry => entry.id),
        },
    };
}

function buildFinalData(feed, entries, parsed, config) {
    const generatedAt = new Date().toISOString();
    const result = buildTopics(entries, parsed);
    return {
        ...feed,
        generated_at: generatedAt,
        model_id: String(parsed.model_id || parsed.model || config.openrouter_model),
        topics: result.topics,
        topic_meta: {
            generated_at: generatedAt,
            model: String(parsed.model || config.openrouter_model),
            method: 'AI 进行多帖事件语义聚类；本地程序校验并将未可靠合并的帖子保留为独立话题，同时恢复原始字段及计算统计。',
            source: {
                rate_count: feed.rate.length,
                views_count: feed.views.length,
                unique_text_posts: entries.length,
            },
            unmatched: result.unmatched,
        },
    };
}

function validateFinalData(data, minimumTopics) {
    if (!data || !Array.isArray(data.rate) || !Array.isArray(data.views)) throw new PipelineError('最终 JSON 缺少原始榜单');
    if (!Array.isArray(data.topics) || data.topics.length < minimumTopics) throw new PipelineError('最终 JSON 话题数不足');
    if (!data.generated_at || !Number.isFinite(Date.parse(data.generated_at))) throw new PipelineError('最终 JSON 时间戳无效');
    if (!String(data.model_id || '').trim()) throw new PipelineError('最终 JSON 缺少 model_id');
    if (Math.abs(Date.now() - Date.parse(data.generated_at)) > 5 * 60_000) throw new PipelineError('最终 JSON 时间戳不是当前时间');
    if ('attribution' in data) throw new PipelineError('最终 JSON 不应包含 attribution');
    const coveredSourceIds = new Set();
    for (const topic of data.topics) {
        if (!topic.title || !Array.isArray(topic.source_ids) || !topic.source_ids.length) {
            throw new PipelineError('最终 JSON 包含无效话题');
        }
        for (const sourceId of topic.source_ids) {
            if (coveredSourceIds.has(sourceId)) throw new PipelineError('最终 JSON 包含重复归类的帖子');
            coveredSourceIds.add(sourceId);
        }
    }
    const expectedPostCount = Number(data.topic_meta?.source?.unique_text_posts);
    if (!Number.isInteger(expectedPostCount) || coveredSourceIds.size !== expectedPostCount) {
        throw new PipelineError('最终 JSON 未完整覆盖全部有效帖子');
    }
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized) < 1_000 || Buffer.byteLength(serialized) > 20 * 1024 * 1024) {
        throw new PipelineError('最终 JSON 文件大小异常');
    }
    JSON.parse(serialized);
    return serialized;
}

function writeAtomic(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, contents, 'utf8');
    try {
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        fs.copyFileSync(temporaryPath, filePath);
        fs.unlinkSync(temporaryPath);
    }
}

function buildAiMessages(entries) {
    const titlesText = entries.map(entry => `${entry.index}\t${entry.id}\t${Number(entry.raw.v) || 0}\t${entry.text}`).join('\n');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `下面是待聚类推文，每行格式为“序号<TAB>文章ID<TAB>曝光量<TAB>清洗后的正文”。只返回符合上述纯文本格式的话题行：\n\n${titlesText}` },
    ];
}

async function generateNvidia(config, apiKeys, entries, timeoutMs = Number(config.nvidia_request_timeout_ms)) {
    if (!Array.isArray(apiKeys) || apiKeys.length < 1) {
        throw new PipelineError('NVIDIA API Key 池为空', { code: 'API_KEY_LIST_MISSING' });
    }
    const messages = buildAiMessages(entries);
    const modelId = String(config.nvidia_fallback_model);
    const apiKey = shuffle(apiKeys)[0];
    const modelOptions = getNvidiaModelOptions(modelId);
    const inputChars = messages.reduce((sum, message) => sum + String(message.content || '').length, 0);
    const requestStartedAt = Date.now();
    safeLog('info', 'ai', 'REQUEST_START', {
        provider: 'nvidia', attempt: 1, request_limit: 1, model_id: modelId,
        timeout_ms: timeoutMs, input_posts: entries.length, input_chars: inputChars,
        message_count: messages.length, stream: modelOptions.stream,
        transport_headers_timeout_ms: timeoutMs, transport_body_timeout_ms: timeoutMs,
        effective_max_tokens: modelOptions.max_tokens, temperature: modelOptions.temperature,
        top_p: modelOptions.top_p,
    });
    try {
        const response = await callNvidia(config, apiKey, modelId, messages, timeoutMs, 1);
        logCompleteModelOutput('info', 'nvidia', response.model || modelId, response.content);
        appendModelOutputArtifact({ provider: 'nvidia', modelId: response.model || modelId, attempt: 1, content: response.content, response });
        const parsed = parseAIOutput(response.content, entries, Number(config.minimum_topics));
        safeLog('info', 'ai', 'REQUEST_SUCCESS', {
            provider: 'nvidia', attempt: 1, duration_ms: Date.now() - requestStartedAt,
            model_id: modelId, model: response.model || modelId,
            finish_reason: response.finishReason || undefined,
            response_bytes: response.responseBytes || undefined,
            prompt_tokens: response.promptTokens || undefined,
            completion_tokens: response.completionTokens || undefined,
            grouped_topics: parsed.groups.length,
        });
        logTransportSummary('info', 'nvidia', modelId, 200, response);
        return { ...parsed, model: response.model || modelId, model_id: modelId };
    } catch (error) {
        const failure = error instanceof PipelineError ? error : new PipelineError('NVIDIA AI 处理失败', { code: 'AI_UNEXPECTED_ERROR', model: modelId });
        safeLog('warn', 'ai', 'REQUEST_FAILED_NO_RETRY', {
            provider: 'nvidia', attempt: 1, code: failure.code,
            duration_ms: Date.now() - requestStartedAt, status: failure.status || undefined,
            model: failure.model || modelId, parsed_topics: failure.parsedTopics || undefined,
            detail: failure.message,
        });
        throw failure;
    }
}

async function generateOnce(config, keys, entries, timeoutMs = Number(config.openrouter_request_timeout_ms)) {
    const messages = buildAiMessages(entries);
    const requestStartedAt = Date.now();
    safeLog('info', 'ai', 'REQUEST_START', { request_limit: 1, provider: 'openrouter' });
    try {
        const response = await callOpenRouter(config, keys[0], messages, timeoutMs, 1);
        logCompleteModelOutput('info', 'openrouter', response.model || config.openrouter_model, response.content);
        appendModelOutputArtifact({
            provider: 'openrouter',
            modelId: response.model || config.openrouter_model,
            attempt: 1,
            content: response.content,
            response,
        });
        let parsed;
        try {
            parsed = parseAIOutput(response.content, entries, Number(config.minimum_topics));
        } catch (error) {
            if (error instanceof PipelineError) {
                error.model = response.model;
                error.finishReason = response.finishReason;
                error.responseBytes = response.responseBytes;
                error.promptTokens = response.promptTokens;
                error.completionTokens = response.completionTokens;
                error.contentChars = response.contentChars;
                error.reasoningChars = response.reasoningChars;
                error.reasoningTokens = response.reasoningTokens;
                error.contentType = response.contentType;
                error.rawResponse = response.rawResponse;
            }
            throw error;
        }
        safeLog('info', 'ai', 'REQUEST_SUCCESS', {
            duration_ms: Date.now() - requestStartedAt,
            model: response.model || config.openrouter_model,
            finish_reason: response.finishReason || undefined,
            response_bytes: response.responseBytes || undefined,
            prompt_tokens: response.promptTokens || undefined,
            completion_tokens: response.completionTokens || undefined,
            grouped_topics: parsed.groups.length,
        });
        logTransportSummary('info', 'openrouter', response.model || config.openrouter_model, 200, response);
        return {
            ...parsed,
            model: response.model || config.openrouter_model,
        };
    } catch (error) {
        const failure = error instanceof PipelineError ? error : new PipelineError('AI 处理失败', { code: 'AI_UNEXPECTED_ERROR' });
        safeLog('warn', 'ai', 'REQUEST_FAILED_NO_RETRY', {
            code: failure.code,
            duration_ms: Date.now() - requestStartedAt,
            status: failure.status || undefined,
            model: failure.model || undefined,
            finish_reason: failure.finishReason || undefined,
            response_bytes: failure.responseBytes || undefined,
            prompt_tokens: failure.promptTokens || undefined,
            completion_tokens: failure.completionTokens || undefined,
            content_type: failure.contentType || undefined,
            content_chars: failure.contentChars || undefined,
            reasoning_chars: failure.reasoningChars || undefined,
            reasoning_tokens: failure.reasoningTokens || undefined,
            parsed_topics: failure.parsedTopics || undefined,
            detail: failure.message,
        });
        if (failure.contentChars || failure.reasoningChars) {
            logTransportSummary('warn', 'openrouter', failure.model || config.openrouter_model, failure.status, failure);
        } else {
            safeRawLog('warn', 'ai', 'RESPONSE_RAW', {
                provider: 'openrouter', status: failure.status || 0,
                content_type: failure.contentType || '', body: failure.rawResponse || '',
            });
        }
        throw failure;
    }
}

async function generateWithFallback(config, openRouterKeys, nvidiaKeys, entries) {
    const deadline = Date.now() + Number(config.overall_task_timeout_ms);
    const openRouterTimeoutMs = Math.min(
        Number(config.openrouter_request_timeout_ms),
        Math.max(1_000, deadline - Date.now()),
    );
    let primaryFailure;
    try {
        return await generateOnce(config, openRouterKeys, entries, openRouterTimeoutMs);
    } catch (error) {
        primaryFailure = error instanceof PipelineError ? error : new PipelineError('OpenRouter 处理失败', { code: 'AI_UNEXPECTED_ERROR' });
        safeLog('warn', 'ai', 'FALLBACK_START', {
            from_provider: 'openrouter', to_provider: 'nvidia',
            primary_code: primaryFailure.code, primary_detail: primaryFailure.message,
            fallback_model: config.nvidia_fallback_model,
        });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) {
        throw new PipelineError(`OpenRouter 失败且已无 NVIDIA 兜底时间：${primaryFailure.message}`, {
            code: 'AI_FALLBACK_BUDGET_EXHAUSTED',
        });
    }
    try {
        return await generateNvidia(config, nvidiaKeys, entries, Math.min(Number(config.nvidia_request_timeout_ms), remainingMs));
    } catch (error) {
        const fallbackFailure = error instanceof PipelineError ? error : new PipelineError('NVIDIA 处理失败', { code: 'AI_UNEXPECTED_ERROR' });
        throw new PipelineError(`OpenRouter 失败（${primaryFailure.code}）：${primaryFailure.message}；NVIDIA MiniMax 兜底失败（${fallbackFailure.code}）：${fallbackFailure.message}`, {
            code: 'AI_BOTH_PROVIDERS_FAILED',
            model: config.nvidia_fallback_model,
        });
    }
}

async function main() {
    const config = await runPhase('config', async () => readConfig(), value => ({
        openrouter_request_timeout_ms: Number(value.openrouter_request_timeout_ms),
        nvidia_request_timeout_ms: Number(value.nvidia_request_timeout_ms),
        stream_idle_timeout_ms: Number(value.stream_idle_timeout_ms),
        overall_task_timeout_ms: Number(value.overall_task_timeout_ms),
        openrouter_model: value.openrouter_model,
        nvidia_fallback_model: value.nvidia_fallback_model,
    }));
    const credentials = await runPhase('credentials', async () => ({
        sourceUrl: readSecret('XBANGDAN_API_URL'),
        openRouterKeys: readApiKeys(),
        nvidiaKeys: readSecretLines('NVIDIA_API_KEY'),
    }), value => ({ openrouter_key_count: value.openRouterKeys.length, nvidia_key_count: value.nvidiaKeys.length }));
    if (credentials.nvidiaKeys.length < 1) throw new PipelineError('NVIDIA_API_KEY 中没有可用 Key', { code: 'API_KEY_LIST_MISSING' });
    const feed = await runPhase('upstream', async () => downloadFeed(credentials.sourceUrl), value => ({
        rate_count: value.rate.length,
        views_count: value.views.length,
    }));
    const entries = await runPhase('extract', async () => extractEntries(feed), value => ({ posts: value.length }));
    initializeModelOutputArtifact();
    const parsed = await runPhase('ai', async () => generateWithFallback(config, credentials.openRouterKeys, credentials.nvidiaKeys, entries), value => ({
        grouped_topics: value.groups.length,
        model: value.model || config.openrouter_model,
    }));
    const finalData = await runPhase('build', async () => buildFinalData(feed, entries, parsed, config), value => ({ topics: value.topics.length }));
    const contents = await runPhase('validate', async () => validateFinalData(finalData, Number(config.minimum_topics)), value => ({
        output_bytes: Buffer.byteLength(value),
    }));
    await runPhase('write', async () => writeAtomic(outputPath, contents));
    return { topics: finalData.topics.length, posts: entries.length };
}

export { MAX_MODEL_OUTPUT_ARTIFACT_BYTES, SAFE_LOG_LIMIT_BYTES, SYSTEM_PROMPT, appendModelOutputArtifact, buildFinalData, extractEntries, generateNvidia, generateOnce, generateWithFallback, initializeModelOutputArtifact, logCompleteModelOutput, parseAIOutput, readOpenRouterStream, redactSensitiveModelOutput, sanitizeLogText, validateFinalData };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const runStartedAt = Date.now();
    main().then(result => {
        const durationMs = Date.now() - runStartedAt;
        safeLog('info', 'pipeline', 'COMPLETE', { duration_ms: durationMs, ...result });
        writeJobSummary({ status: 'success', phase: 'complete', durationMs, ...result });
    }).catch(error => {
        const pipelineError = error instanceof PipelineError ? error : new PipelineError('任务执行失败', { code: 'UNEXPECTED_ERROR' });
        const durationMs = Date.now() - runStartedAt;
        safeLog('error', 'pipeline', 'FAILED', {
            failed_phase: pipelineError.phase || 'unknown',
            code: pipelineError.code,
            duration_ms: durationMs,
            detail: pipelineError.message,
        });
        writeJobSummary({
            status: 'failed',
            phase: pipelineError.phase || 'unknown',
            code: pipelineError.code,
            detail: `${pipelineError.message}；上一版数据保持不变`,
            durationMs,
        });
        process.exitCode = 1;
    });
}
