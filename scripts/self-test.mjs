import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_MODEL_OUTPUT_ARTIFACT_BYTES, SAFE_LOG_LIMIT_BYTES, SYSTEM_PROMPT, appendModelOutputArtifact, buildFinalData, extractEntries, generateWithFallback, generateOnce, initializeModelOutputArtifact, logCompleteModelOutput, parseAIOutput, readOpenRouterStream, redactSensitiveModelOutput, sanitizeLogText, validateFinalData } from './update-data.mjs';

const modelOutputArtifactUrl = new URL('../data/ai_model_output.txt', import.meta.url);

assert.equal(SAFE_LOG_LIMIT_BYTES, 10 * 1024 * 1024);
assert.match(SYSTEM_PROMPT, /观点性缩略/);
assert.match(SYSTEM_PROMPT, /浓缩标题----文章ID1,文章ID2----#标签1/);
assert.match(SYSTEM_PROMPT, /正确示例/);
assert.match(SYSTEM_PROMPT, /错误示例/);
assert.match(SYSTEM_PROMPT, /只有一个 ID/);
assert.match(SYSTEM_PROMPT, /优先参考曝光量高且信息完整的帖子/);
assert.match(SYSTEM_PROMPT, /不要把尖锐观点改成中立分类/);
assert.match(SYSTEM_PROMPT, /程序会排序/);

const makePost = (id, group, position) => ({
    id: String(id),
    h: `user${position}`,
    n: `用户${position}`,
    t: `这是第${group}组新闻事件的完整测试正文，包含足够的信息用于验证聚类、统计和最终 JSON 结构。`.repeat(3),
    v: 10000 * position,
    l: 100 * position,
    r: position,
});

const feed = {
    updated: Date.now(),
    rate: [makePost(10001, 1, 1), makePost(10002, 1, 2), makePost(10003, 2, 3)],
    views: [makePost(10004, 2, 4), makePost(10005, 3, 5), makePost(10006, 3, 6)],
};
const entries = extractEntries(feed);
const overLimitSource = Array.from({ length: 220 }, (_, index) => makePost(30001 + index, index + 1, index + 1));
const topOneHundredFiftyEntries = extractEntries({ rate: overLimitSource, views: [] });
assert.equal(topOneHundredFiftyEntries.length, 150);
assert.equal(topOneHundredFiftyEntries[0].raw.v, 2200000);
assert.equal(topOneHundredFiftyEntries.at(-1).raw.v, 710000);
const belowLimitSource = Array.from({ length: 149 }, (_, index) => makePost(40001 + index, index + 1, index + 1));
assert.equal(extractEntries({ rate: belowLimitSource, views: [] }).length, 149);
const parsed = parseAIOutput(JSON.stringify({ topics: [
    { title: '第一组测试新闻事件', indices: [5, 6], tags: ['#测试', '#第一组', '#新闻'] },
    { title: '第二组测试新闻事件', indices: [3, 4], tags: ['#测试', '#第二组', '#新闻'] },
    { title: '第三组测试新闻事件', indices: [1, 2], tags: ['#测试', '#第三组', '#新闻'] },
] }), entries, 3);
const plainParsed = parseAIOutput([
    `第三组测试新闻事件----${entries[4].id},${entries[5].id}----#测试,#第三组,#新闻`,
    `第二组测试新闻事件----${entries[2].id},${entries[3].id}----#测试,#第二组,#新闻`,
    `第一组测试新闻事件----${entries[0].id},${entries[1].id}----#测试,#第一组,#新闻`,
].join('\n'), entries, 3);
assert.deepEqual(plainParsed.groups.map(group => group.items.map(item => item.id)), [
    [entries[4].id, entries[5].id],
    [entries[2].id, entries[3].id],
    [entries[0].id, entries[1].id],
]);
const tolerantPlainParsed = parseAIOutput([
    `第三组测试新闻事件--${entries[4].id},${entries[5].id}--#测试,#第三组,#新闻`,
    `第二组测试新闻事件--${entries[2].id},${entries[3].id}--#测试,#第二组,#新闻`,
    `第一组测试新闻事件--${entries[0].id},${entries[1].id}--#测试,#第一组,#新闻`,
].join('\n'), entries, 3);
assert.equal(tolerantPlainParsed.groups.length, 3);
assert.throws(() => parseAIOutput(`只有单帖的话题--${entries[0].id}--#测试,#单帖,#拒绝`, entries, 1));
assert.throws(() => parseAIOutput(
    `两个话题粘连--${entries[0].id},${entries[1].id}--#测试,#粘连,#拒绝--${entries[2].id},${entries[3].id}--#额外,#字段,#拒绝`,
    entries,
    1,
));
const singletonPlainParsed = parseAIOutput([
    `${'这是模型生成的较长单帖标题'.repeat(8)}----${entries[0].id}----#模型,#单帖`,
    `第二个合法单帖测试标题----${entries[1].id}----#模型,#单帖,#测试`,
    `第三个合法单帖测试标题----${entries[2].id}----#模型`,
].join('\n'), entries, 3);
assert.equal(singletonPlainParsed.groups.length, 3);
assert.equal(singletonPlainParsed.groups.every(group => group.items.length === 1), true);
assert.equal(singletonPlainParsed.groups.every(group => group.tags.length >= 3), true);
assert.equal(singletonPlainParsed.groups.every(group => [...group.title].length <= 60), true);
const oneCharacterPlainParsed = parseAIOutput(
    `A----${entries[0].id}----#短标题`,
    entries,
    1,
);
assert.equal(oneCharacterPlainParsed.groups[0].title, 'A');
const oneCharacterJsonParsed = parseAIOutput(JSON.stringify({ topics: [
    { title: 'A', indices: [1], tags: ['#短标题'] },
] }), entries, 1);
assert.equal(oneCharacterJsonParsed.groups[0].title, 'A');
const unicodeFallbackFeed = {
    rate: [
        { id: '2094523850277130428', h: 'thankucrypto', n: 'allincrypto 熬鹰资本 🇨🇳', t: '舒服了。', v: 1, l: 1, r: 1 },
        { id: '2094523850277130429', h: 'plainuser', n: '普通用户', t: '这是一条普通测试文本。', v: 1, l: 1, r: 1 },
    ],
    views: [],
};
const unicodeFallbackEntries = extractEntries(unicodeFallbackFeed);
const unicodeFallbackFinalData = buildFinalData(
    unicodeFallbackFeed,
    unicodeFallbackEntries,
    { groups: [], assigned: new Map() },
    { model: 'openrouter/free' },
);
assert.doesNotThrow(() => validateFinalData(unicodeFallbackFinalData, 1));
assert.match(unicodeFallbackFinalData.topics[0].title, /🇨🇳/u);
const overlappingParsed = parseAIOutput([
    `首个合法重叠测试话题----${entries[0].id},${entries[1].id}----#重叠,#测试,#首个`,
    `应整体拒绝的重叠话题----${entries[1].id},${entries[2].id}----#重叠,#测试,#拒绝`,
].join('\n'), entries, 1);
assert.equal(overlappingParsed.groups.length, 1);
assert.equal(overlappingParsed.assigned.has(entries[2].index), false);
parsed.model = 'test/provider-model:free';
parsed.model_id = 'test/provider-model';
const finalData = buildFinalData(feed, entries, parsed, { model: 'openrouter/free' });
const serialized = validateFinalData(finalData, 3);

assert.equal(finalData.topics.length, 3);
assert.equal(typeof finalData.generated_at, 'string');
assert.equal('attribution' in finalData, false);
assert.equal(finalData.topic_meta.model, 'test/provider-model:free');
assert.equal(finalData.model_id, 'test/provider-model');
assert.deepEqual(JSON.parse(serialized).topics.map(topic => topic.rank), [1, 2, 3]);
assert.throws(() => parseAIOutput('无法解析', entries, 3));
const partialParsed = parseAIOutput(JSON.stringify({ topics: [
    { title: '只覆盖部分帖子的测试话题', indices: [1, 2], tags: ['#测试', '#遗漏', '#校验'] },
] }), entries, 1);
partialParsed.model = 'test/provider-model:free';
const partialFinalData = buildFinalData(feed, entries, partialParsed, { model: 'openrouter/free' });
assert.equal(partialFinalData.topics.length, 5);
assert.equal(partialFinalData.topics.filter(topic => topic.source_ids.length === 1).length, 4);
assert.equal(partialFinalData.topics[0].source_ids.length, 2);
assert.equal(partialFinalData.topics[0].title, '只覆盖部分帖子的测试话题');
validateFinalData(partialFinalData, 1);

const manyEntries = Array.from({ length: 32 }, (_, index) => ({
    index: index + 1,
    id: String(20001 + index),
    text: `第${index + 1}条独立事件`,
    raw: makePost(20001 + index, index + 1, index + 1),
}));
const manyTopicsOutput = JSON.stringify({ topics: Array.from({ length: 16 }, (_, index) => ({
    title: `第${index + 1}组完整测试新闻事件`,
    indices: [index * 2 + 1, index * 2 + 2],
    tags: ['#测试', '#完整覆盖', '#多帖话题'],
})) });
assert.equal(parseAIOutput(manyTopicsOutput, manyEntries, 1).groups.length, 16);

const streamResponse = new Response([
    'data: {"model":"test/provider-model:free","choices":[{"delta":{"reasoning_content":"内部推理"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"{\\\"topics\\\":"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
    '',
    'data: [DONE]',
    '',
].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
const streamed = await readOpenRouterStream(streamResponse, 1_000, new AbortController());
assert.equal(streamed.content, '{"topics":[]}');
assert.equal(streamed.model, 'test/provider-model:free');
assert.equal(streamed.finishReason, 'stop');
assert.equal(streamed.promptTokens, 12);
assert.equal(streamed.completionTokens, 4);
assert.equal(streamed.responseBytes > 0, true);
assert.equal(streamed.reasoningChars, 4);

const errorStreamResponse = new Response([
    'data: {"model":"test/provider-model","choices":[{"delta":{"content":"部分可见输出"}}]}',
    '',
    'data: {"error":{"code":500,"message":"upstream failed"}}',
    '',
].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
await assert.rejects(
    () => readOpenRouterStream(errorStreamResponse, 1_000, new AbortController(), 'NVIDIA'),
    error => error?.code === 'AI_STREAM_ERROR'
        && error?.status === 500
        && error?.content === '部分可见输出'
        && error?.contentChars === 6
        && error?.responseBytes > 0
        && error?.rawResponse.includes('upstream failed'),
);

const stalledStream = new ReadableStream({ cancel() {} });
const stalledResponse = new Response(stalledStream, { headers: { 'content-type': 'text/event-stream' } });
await assert.rejects(
    () => readOpenRouterStream(stalledResponse, 10, new AbortController()),
    error => error?.code === 'AI_STREAM_IDLE_TIMEOUT',
);

process.env.OPENROUTER_API_KEY = 'sk-test-secret-value-123456';
process.env.XBANGDAN_API_URL = 'https://secret.example.test/feed?token=private-value';
const sanitized = sanitizeLogText(`Bearer sk-test-secret-value-123456 https://secret.example.test/feed?token=private-value ${'x'.repeat(600)}`);
assert.equal(sanitized.includes('secret-value'), false);
assert.equal(sanitized.includes('secret.example.test'), false);
assert.equal(sanitized.length < 550, true);

process.env.NVIDIA_API_KEY = 'nvapi-test-secret-value-987654';
const artifactSanitized = redactSensitiveModelOutput([
    'normal post URL: https://example.com/public-post',
    'key exact: nvapi-test-secret-value-987654',
    'url exact: https://secret.example.test/feed?token=private-value',
    'apiurl=https://another-secret.example/api',
    'callback=https://safe.example/callback?api_key=hidden-value',
].join('\n'));
assert.equal(artifactSanitized.text.includes('test-secret-value'), false);
assert.equal(artifactSanitized.text.includes('secret.example.test'), false);
assert.equal(artifactSanitized.text.includes('hidden-value'), false);
assert.equal(artifactSanitized.text.includes('https://example.com/public-post'), true);
assert.equal(artifactSanitized.findings.includes('api_key_exact'), true);
assert.equal(artifactSanitized.findings.includes('api_url_exact'), true);
assert.equal(artifactSanitized.findings.includes('api_url_assignment'), true);
assert.equal(artifactSanitized.findings.includes('url_credential'), true);
initializeModelOutputArtifact();

const originalConsoleLog = console.log;
const capturedOutputLines = [];
const completeOutput = `第一行----10001,10002----#测试,#完整,#输出\n${'完整模型输出'.repeat(2200)}`;
try {
    console.log = line => capturedOutputLines.push(String(line));
    logCompleteModelOutput('info', 'nvidia', 'test/model', completeOutput);
} finally {
    console.log = originalConsoleLog;
}
const capturedOutputEvents = capturedOutputLines.map(line => JSON.parse(line));
assert.equal(capturedOutputEvents.length > 1, true);
assert.equal(capturedOutputEvents.every(event => event.event === 'MODEL_OUTPUT_RAW'), true);
assert.equal(capturedOutputEvents.map(event => event.data).join(''), completeOutput);

const originalFetch = globalThis.fetch;
const aiConfig = {
    ai_api: 'https://openrouter.ai/api/v1/chat/completions',
    nvidia_api: 'https://integrate.api.nvidia.com/v1/chat/completions',
    openrouter_model: 'minimax/minimax-m3:free',
    nvidia_fallback_model: 'minimaxai/minimax-m3',
    temperature: 1,
    top_p: 0.95,
    max_tokens: 32768,
    minimum_topics: 3,
    openrouter_request_timeout_ms: 1_000,
    nvidia_request_timeout_ms: 1_000,
    stream_idle_timeout_ms: 1_000,
    overall_task_timeout_ms: 3_000,
};
const validModelContent = [
    '第一组测试新闻事件----10001,10002----#测试,#第一组,#新闻',
    '第二组测试新闻事件----10003,10004----#测试,#第二组,#新闻',
    '第三组测试新闻事件----10005,10006----#测试,#第三组,#新闻',
].join('\n');

let openRouterRequestCount = 0;
try {
    globalThis.fetch = async (_url, options) => {
        openRouterRequestCount += 1;
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, 'minimax/minimax-m3:free');
        assert.equal(payload.stream, false);
        assert.deepEqual(payload.reasoning, { effort: 'low', exclude: true });
        assert.equal('provider' in payload, false);
        return new Response('', { status: 429 });
    };
    await assert.rejects(
        () => generateOnce(aiConfig, ['first-test-key', 'second-test-key'], entries),
        error => error?.code === 'AI_HTTP_429',
    );
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(openRouterRequestCount, 1);

let primarySuccessOpenRouterCount = 0;
let primarySuccessNvidiaCount = 0;
try {
    globalThis.fetch = async (url, options) => {
        if (String(url).includes('openrouter.ai')) primarySuccessOpenRouterCount += 1;
        else primarySuccessNvidiaCount += 1;
        const payload = JSON.parse(options.body);
        return Response.json({
            model: payload.model,
            choices: [{ message: { content: validModelContent }, finish_reason: 'stop' }],
        });
    };
    const result = await generateWithFallback(aiConfig, ['test-openrouter-key'], ['test-nvidia-key'], entries);
    assert.equal(result.model, 'minimax/minimax-m3:free');
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(primarySuccessOpenRouterCount, 1);
assert.equal(primarySuccessNvidiaCount, 0);

let fallbackOpenRouterCount = 0;
let fallbackNvidiaCount = 0;
try {
    globalThis.fetch = async (url, options) => {
        if (String(url).includes('openrouter.ai')) {
            fallbackOpenRouterCount += 1;
            return new Response('', { status: 503 });
        }
        fallbackNvidiaCount += 1;
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, 'minimaxai/minimax-m3');
        assert.deepEqual(
            { temperature: payload.temperature, top_p: payload.top_p, max_tokens: payload.max_tokens, stream: payload.stream },
            { temperature: 1, top_p: 0.95, max_tokens: 8192, stream: false },
        );
        assert.match(payload.messages[1].content, /序号<TAB>文章ID<TAB>曝光量<TAB>清洗后的正文/);
        return Response.json({
            model: payload.model,
            choices: [{ message: { content: validModelContent }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
        });
    };
    const result = await generateWithFallback(aiConfig, ['test-openrouter-key'], ['test-nvidia-key'], entries);
    assert.equal(result.model_id, 'minimaxai/minimax-m3');
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(fallbackOpenRouterCount, 1);
assert.equal(fallbackNvidiaCount, 1);

let validationFallbackRequestCount = 0;
try {
    globalThis.fetch = async (_url, options) => {
        validationFallbackRequestCount += 1;
        const payload = JSON.parse(options.body);
        return Response.json({
            model: payload.model,
            choices: [{ message: { content: validationFallbackRequestCount === 1 ? '无法解析的模型输出' : validModelContent }, finish_reason: 'stop' }],
        });
    };
    const result = await generateWithFallback(aiConfig, ['test-openrouter-key'], ['test-nvidia-key'], entries);
    assert.equal(result.model_id, 'minimaxai/minimax-m3');
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(validationFallbackRequestCount, 2);

let bothFailRequestCount = 0;
try {
    globalThis.fetch = async () => {
        bothFailRequestCount += 1;
        return new Response('', { status: 500 });
    };
    await assert.rejects(
        () => generateWithFallback(aiConfig, ['test-openrouter-key'], ['test-nvidia-key'], entries),
        error => error?.code === 'AI_BOTH_PROVIDERS_FAILED'
            && error.message.includes('OpenRouter')
            && error.message.includes('NVIDIA MiniMax'),
    );
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(bothFailRequestCount, 2);

const diagnosticArtifact = fs.readFileSync(modelOutputArtifactUrl, 'utf8');
assert.match(diagnosticArtifact, /record_type: request/);
assert.match(diagnosticArtifact, /record_type: response/);
assert.match(diagnosticArtifact, /"messages": \[/);
assert.match(diagnosticArtifact, /"url": "\[REDACTED_API_URL\]"/);
assert.match(diagnosticArtifact, /"authorization": "Bearer \[REDACTED_API_KEY\]"/);
assert.match(diagnosticArtifact, /finish_reason: stop/);
assert.match(diagnosticArtifact, /api_output_truncated: no/);
assert.match(diagnosticArtifact, /error_code: AI_HTTP_429/);
assert.match(diagnosticArtifact, /--- raw response\/error body ---/);
const firstRecordedRequest = diagnosticArtifact.split('--- request ---\n', 2)[1].split('\n================================================================================', 1)[0];
assert.doesNotThrow(() => JSON.parse(firstRecordedRequest));
assert.equal(diagnosticArtifact.includes(process.env.NVIDIA_API_KEY), false);
assert.equal(diagnosticArtifact.includes(process.env.XBANGDAN_API_URL), false);

initializeModelOutputArtifact();
appendModelOutputArtifact({
    provider: 'nvidia',
    modelId: 'test/model',
    attempt: 1,
    content: '',
    response: {
        errorCode: 'TEST_OVERSIZED_FAILURE',
        errorMessage: 'oversized failure response',
        rawResponse: '异常响应'.repeat(MAX_MODEL_OUTPUT_ARTIFACT_BYTES),
    },
});
const cappedArtifactBytes = fs.statSync(modelOutputArtifactUrl).size;
const cappedArtifact = fs.readFileSync(modelOutputArtifactUrl, 'utf8');
assert.equal(cappedArtifactBytes <= MAX_MODEL_OUTPUT_ARTIFACT_BYTES, true);
assert.match(cappedArtifact, /artifact truncated at 2097152 bytes/);
fs.unlinkSync(modelOutputArtifactUrl);

console.log('self-test: ok');
